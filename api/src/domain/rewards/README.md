# Rewards domain

Merchant vouchers: create, list, edit, claim with points and redeem by serial code.

- `rewards.service.ts`: voucher use cases.
- `voucher-validation.ts`: runtime create/edit validation; merged edits are validated while the voucher row is locked.
- `rewards.module.ts`: Nest provider composition.

Persistence is `infra/db/repositories/rewards.repository.ts`; HTTP is `api/rest/rewards.controller.ts`.

## Consistency and ledger boundary

Paid voucher claims reuse the customer-signed `credit_account::redeem` pipeline under their own durable command type, `VOUCHER_CLAIM_RESERVE` (a free claim is `VOUCHER_CLAIM`), so recovery never has to inspect a payload to tell a claim from a POS reserve. Sui is authoritative for the debit; PostgreSQL stores the voucher catalog/serials and projects the confirmed point balance.

`POST /v1/rewards/vouchers/:id/claim` requires a stable idempotency key for a paid reward. In one PostgreSQL transaction it locks catalog stock and the member balance, creates a PENDING REDEEM, holds points in `pendingRedemption`, reserves supply and creates a RESERVED ownership. It does not debit `confirmedBalance`, consume live buckets or emit a confirmation webhook yet. The response includes `transactionId`, `pointsCost`, `pointsDeducted: 0`, `digest` and `transactionBytes` for the customer's zkLogin/Enoki session to sign. Free rewards require no chain debit and become AVAILABLE immediately.

The customer's device sends `{ digest, signature }` to the existing public `POST /v1/credits/redeem/finalize` endpoint. Only the customer's chain-verified signature authorizes spending; merchant keys stay on trusted servers. A successful chain verdict, indexer event, or digest reconciliation atomically debits the point projection, consumes buckets, releases the point hold and activates the ownership. The existing `credits.redemption.confirmed` outbox event includes the chain digest. A RESERVED serial cannot be redeemed. `GET /v1/rewards/claims/:ownershipId` reads the tenant-scoped persisted state after asynchronous recovery; retrying claim also returns its current state.

The chain reference is `voucher-claim-<ownershipId>`, allowing the existing indexer and `reverse_redeem` path to match the claim.

### Reversing a claim

A merchant reverses a paid claim through `POST /v1/credits/transactions/:transactionId/reverse` on its REDEEM transaction. Refund eligibility uses the immutable policy snapshot taken when the coupon was claimed. With the default policy, the points and coupon move together:

| Coupon when reversed | Result |
| --- | --- |
| RESERVED | Not reversible: the transaction is still PENDING. Failure or abandonment releases it instead. |
| AVAILABLE, not past its expiry | The coupon is CANCELLED, its unit returns to the catalog (a DEPLETED voucher becomes ACTIVE again) and the points are refunded, in one transaction. |
| REDEEMED | 409. The benefit was delivered, so nothing changes. To compensate the member, issue an earn with its own reason. |
| EXPIRED, or AVAILABLE past its expiry | 409. The benefit lapsed under the voucher's terms; same as REDEEMED. |

The reversal locks the voucher row before cancelling the coupon, as redemption does, so a coupon used at checkout while it is being reversed ends up either REDEEMED with the points kept or CANCELLED with the points refunded, never both. Configured policies may also allow refunds of redeemed or expired coupons, but those refunds additionally require an `admin` scope on the calling credential. These preserve REDEEMED/EXPIRED and never replenish stock. Free claims have no REDEEM transaction and so cannot be reversed. Existing reversal limitations documented in the roadmap still apply.

Definitive chain failure cancels the ownership and releases stock and points together. An unsigned claim is abandoned after 30 minutes by the worker reconciler or lazily on a balance read, POS reserve or another voucher claim. Both paths cancel reserved coupons and return their stock in the same transaction as releasing the point hold. Continuing the same unsigned claim refreshes its abandonment clock. The expiration path locks and rechecks the operation before releasing anything, so it cannot release a claim concurrently submitted by finalize. Submitted digests remain reserved until their outcome is known, including after Redis cache expiry. A different digest cannot replace an already-submitted digest. Sponsorship errors leave the durable reservation retryable with the same key; otherwise the unsigned-claim timeout releases it.

A changed voucher/member payload under the same organization-scoped key returns 409. Concurrent claims cannot oversell stock or spend points held by another voucher/POS request. The per-member rule permits only one non-cancelled ownership per voucher; failed/cancelled attempts remain auditable and a new key can start a new claim. The new partial unique-index migration enforces that rule. Historical pre-migration Postgres-only claims remain historical records; this change does not fabricate chain receipts or debit them again.

## Lifecycle

`POST /v1/rewards/vouchers` keeps the existing ACTIVE default and also accepts DRAFT or PAUSED. `PATCH /v1/rewards/vouchers/:id` edits permitted fields or sets DRAFT/ACTIVE/PAUSED. Both require a merchant `write` scope; reads require `read`.

After a claim exists, code, points cost, discount type/value and availability dates are immutable. Title/description/metadata, supply and claim availability can still be managed. Supply cannot fall below claimed count; an exhausted or expired voucher cannot be activated. Increasing exhausted supply requires explicit activation. Pausing prevents new claims but does not revoke already-issued vouchers or alter their benefit/expiry.

Dates must be real calendar dates in ISO date-time format with seconds and a timezone (for example `2030-01-01T00:00:00Z`). Impossible dates and out-of-range times are rejected. Numerically equivalent discount strings such as `10` and `10.00` represent the same benefit.

Claims and serial redemption reject inactive organizations, blocked global identities or inactive organization members. Expired ownership cannot be redeemed. Redemption locks the ownership and permits exactly one AVAILABLE → REDEEMED transition; a repeated use returns 400. The successful transition queues exactly one `voucher.redeemed` webhook in the same database transaction, retaining OCT-244's outbox guarantee.

## Configurable organization refund policies

This is separate from the Sui points policy. Settings are data in the append-only `voucher_refund_policies` table; `domain/rewards/refund-policy.ts` evaluates them. The reversal repository invokes that evaluator on the current coupon after locking its catalog and ownership rows. Eligibility, coupon state, catalog stock, points reversal and audit metadata commit or roll back together. The existing worker dispatch/reconciliation of the on-chain reversal is unchanged; its documented asynchronous reversal limitations still apply.

- `GET /v1/rewards/refund-policy` (`read`): latest settings for future claims, or default version 0.
- `PUT /v1/rewards/refund-policy` (`admin`): full replacement, appending a new version.
- `GET /v1/rewards/refund-policy/history` (`admin`): history newest first; `limit` defaults to 50 (maximum 100), with an exclusive `beforeVersion` cursor.

Example replacement body:

```json
{
  "allowUnused": true,
  "allowExpired": true,
  "allowRedeemed": false,
  "restockUnused": true,
  "refundWindowDays": 30,
  "reason": "Allow unused and expired coupon refunds within thirty days"
}
```

All settings are required. `refundWindowDays` is null (no limit) or an integer from 1 to 3650, measured as elapsed days since claim; the boundary is exclusive. The default permits only unused/unexpired refunds, returns their stock, and has no time limit. The default is also applied to pre-migration coupons. New coupons snapshot the latest policy version and return it as `refundPolicy` in claim and member-voucher responses; retries keep their original snapshot. A policy update never changes already-issued coupons.

Publishing records the credential actor, timestamp and required reason. The actor ID remains in history even after that credential is removed. Concurrent publishers allocate distinct sequential versions. The policy table permits tenant-scoped SELECT and INSERT, not UPDATE or DELETE, for the application role. A refund records the applied policy, prior coupon state, decision and stock effect on the REVERSAL transaction, alongside the existing refund reason. The existing reversal unique index prevents a second refund of the same claim.

An allowed unused refund cancels the coupon; stock returns only when `restockUnused` is true. Setting it to false means each claim permanently consumes a limited campaign allocation, including cancellations; `claimedCount` therefore remains allocated. Use true when canceled inventory should become claimable again.

An allowed redeemed/expired refund preserves usage/expiry history and never returns stock, even if `restockUnused` is true. Refunding never reactivates a coupon or extends its expiry.

For example, `refundWindowDays: 1` permits a points refund strictly before 24 elapsed hours after claiming. This is not an appointment-relative deadline: returning a booking voucher when canceling at least 24 hours before an appointment needs appointment data and a separately designed reactivation/reissuance operation. An explicit used-coupon refund is an exceptional service recovery action, such as a benefit delivered incorrectly; it retains the delivered-benefit history and requires admin authorization.

RESERVED and CANCELLED coupons remain ineligible under every policy. Approval queues, staff-role rules, expiry extensions, reissuance and frontend settings are not provided by these endpoints. Until console authentication lands, use server-side admin-scoped API credentials to configure policies; ordinary write credentials may refund only unused, unexpired coupons permitted by their snapshot. Refunding a redeemed or expired coupon requires both claim-time policy opt-in and an `admin` scope (alongside the reversal endpoint's `write` scope), checked against the locked coupon state. An expired AVAILABLE coupon follows the same admin requirement.

Node SDK: `getVoucherRefundPolicy`, `setVoucherRefundPolicy`, `listVoucherRefundPolicyHistory(query?, options?)`; all accept `RequestOptions`. Never put an admin credential in a browser.

Apply migration `0013_voucher_refund_policies` after `0012_voucher_claim_reserve_command_type` and deploy the corresponding API/worker code together. Existing coupon data does not need to be reset for the migration.