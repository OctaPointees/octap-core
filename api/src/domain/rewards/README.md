# Rewards domain

Merchant vouchers: create, list, edit, claim with points and redeem by serial code.

- `rewards.service.ts`: voucher use cases.
- `voucher-validation.ts`: runtime create/edit validation; merged edits are validated while the voucher row is locked.
- `rewards.module.ts`: Nest provider composition.

Persistence is `infra/db/repositories/rewards.repository.ts`; HTTP is `api/rest/rewards.controller.ts`.

## Consistency and ledger boundary

Paid voucher claims reuse the customer-signed `credit_account::redeem` pipeline. Sui is authoritative for the debit; PostgreSQL stores the voucher catalog/serials and projects the confirmed point balance.

`POST /v1/rewards/vouchers/:id/claim` requires a stable idempotency key for a paid reward. In one PostgreSQL transaction it locks catalog stock and the member balance, creates a PENDING REDEEM, holds points in `pendingRedemption`, reserves supply and creates a RESERVED ownership. It does not debit `confirmedBalance`, consume live buckets or emit a confirmation webhook yet. The response includes `transactionId`, `pointsCost`, `pointsDeducted: 0`, `digest` and `transactionBytes` for the customer's zkLogin/Enoki session to sign. Free rewards require no chain debit and become AVAILABLE immediately.

The customer's device sends `{ digest, signature }` to the existing public `POST /v1/credits/redeem/finalize` endpoint. Only the customer's chain-verified signature authorizes spending; merchant keys stay on trusted servers. A successful chain verdict, indexer event, or digest reconciliation atomically debits the point projection, consumes buckets, releases the point hold and activates the ownership. The existing `credits.redemption.confirmed` outbox event includes the chain digest. A RESERVED serial cannot be redeemed. `GET /v1/rewards/claims/:ownershipId` reads the tenant-scoped persisted state after asynchronous recovery; retrying claim also returns its current state.

The chain reference is `voucher-claim-<ownershipId>`, allowing the existing indexer and `reverse_redeem` path to match the claim. Reversing the claim invalidates an unused coupon. Existing reversal limitations documented in the roadmap still apply.

Definitive chain failure cancels the ownership and releases stock and points together. An unsigned claim is abandoned after 30 minutes by the existing worker reconciler. The expiration path locks and rechecks the operation before releasing anything, so it cannot release a claim concurrently submitted by finalize. Submitted digests remain reserved until their outcome is known, including after Redis cache expiry. A different digest cannot replace an already-submitted digest. Sponsorship errors leave the durable reservation retryable with the same key; otherwise the unsigned-claim timeout releases it.

A changed voucher/member payload under the same organization-scoped key returns 409. Concurrent claims cannot oversell stock or spend points held by another voucher/POS request. The per-member rule permits only one non-cancelled ownership per voucher; failed/cancelled attempts remain auditable and a new key can start a new claim. The new partial unique-index migration enforces that rule. Historical pre-migration Postgres-only claims remain historical records; this change does not fabricate chain receipts or debit them again.

## Lifecycle

`POST /v1/rewards/vouchers` keeps the existing ACTIVE default and also accepts DRAFT or PAUSED. `PATCH /v1/rewards/vouchers/:id` edits permitted fields or sets DRAFT/ACTIVE/PAUSED. Both require a merchant `write` scope; reads require `read`.

After a claim exists, code, points cost, discount type/value and availability dates are immutable. Title/description/metadata, supply and claim availability can still be managed. Supply cannot fall below claimed count; an exhausted or expired voucher cannot be activated. Increasing exhausted supply requires explicit activation. Pausing prevents new claims but does not revoke already-issued vouchers or alter their benefit/expiry.

Dates must be real calendar dates in ISO date-time format with seconds and a timezone (for example `2030-01-01T00:00:00Z`). Impossible dates and out-of-range times are rejected. Numerically equivalent discount strings such as `10` and `10.00` represent the same benefit.

Claims and serial redemption reject inactive organizations, blocked global identities or inactive organization members. Expired ownership cannot be redeemed. Redemption locks the ownership and permits exactly one AVAILABLE → REDEEMED transition; a repeated use returns 400.
