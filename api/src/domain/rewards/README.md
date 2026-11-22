# Rewards domain

Merchant vouchers: create, publish, list, edit, claim with points, grant, and use with the customer's signature.

A voucher is a merchant's promise recorded for one customer. OctaP does not define what a voucher looks like: the form and the channel are the merchant's. The chain holds what was promised, who holds it, and whether it was used.

- `rewards.service.ts`: voucher use cases. `createVoucher`/`updateVoucher` take an optional `tx` to join a caller's transaction.
- `console-rewards.service.ts`: the catalog from the console session (OCT-236). Owner or Business Developer reads and writes drafts, checked in the same transaction as the write; only the Owner pauses or changes a published voucher. A console create is always a `DRAFT`, activated with a separate PATCH, and requires `pointsCost`. Every check holds the organization FOR SHARE, because a claim locks the voucher first and the organization second.

## Optional approval (OCT-59)

An Owner can require approval with `PATCH /v1/console/organizations/:id/settings { voucherApprovalRequired: true }` (off by default). Owners never need approval.

| Who | Approval off | Approval on |
|---|---|---|
| Owner | Activates | Activates; approves or rejects what is waiting |
| Business Developer | Activates a draft | `POST …/vouchers/:id/submit`; `…/withdraw` takes it back |
| API key asking for `ACTIVE` (create or PATCH) | Publishes | `PENDING_APPROVAL`, submitted by the key |

- `PENDING_APPROVAL` vouchers cannot be edited, claimed or activated. `approve` (Owner) starts publishing exactly as activating does, after the same checks made again then (24 hours of use left, a program configured); `reject { reason }` (Owner, 1–500 characters) and `withdraw` (Owner or Business Developer) return it to `DRAFT`.
- Resuming a voucher that was already published needs no approval: its terms on-chain cannot change.
- Turning approval off leaves vouchers already waiting as they are; they are still decided the same way.
- Each request is a row of `voucher_approval_requests` (submitter is a user or an API key, at most one PENDING per voucher, RLS by organization). List and detail return the latest as `approval`.
- The repository reads the setting after the voucher's lock, FOR SHARE, the order a claim takes them; changing it locks the organization FOR UPDATE, so a write in progress finishes under the old value.
- No webhook fires for a submission yet.

## Voucher batches (OCT-303)

Many vouchers created as one batch, always as `DRAFT`, reviewed, then activated, paused, resumed or archived together. With an API key (`write` to change, `read` to look): `POST|GET /v1/rewards/voucher-batches`, `GET …/:batchId`, `POST …/:batchId/activate|pause|resume|archive`. In the console, under `/v1/console/organizations/:id/voucher-batches`: the same for the Owner and a Business Developer, plus `POST …/:batchId/approve` and `…/reject { reason }`. As for a single voucher, approving, rejecting, pausing and resuming are the Owner's (pausing and resuming also an API key's), never a Business Developer's.

| Action | Owner (console) | Business Developer (console) | API key |
|---|---|---|---|
| create (`name?`, `dryRun`), list, detail, archive | ✅ | ✅ | ✅ (`write` / `read`) |
| activate | ✅ publishes | ✅ publishes; queued while approval is required | ✅ the same as a Developer |
| approve, reject `{ reason }` | ✅ | ❌ 403 | no route |
| pause, resume | ✅ | ❌ 403 | ✅ |

```
 preview (dryRun) → create batch (DRAFT) → edit (PATCH, as usual) → activate batch   or   archive batch
```

- `voucher-batch.ts`: request and item checks, normalization and comparison (pure, unit-tested). `voucher-batch.service.ts`: the use cases, shared by both route sets. `ConsoleVoucherBatchService` (in `console-rewards.service.ts`): the console's access checks.
- **Create:** 1 to `VOUCHER_BATCH_MAX_ITEMS` (100) items, each `createVoucher`'s fields without `status`. A bad request (no items, too many, not an object) is a 400; each item is otherwise checked and written on its own, in one transaction with a savepoint per item, in `code` order (two batches touching the same codes lock them in the same order). `dryRun` reads and classifies, writes nothing. No batch row is kept when no item landed in it.
- **Per item**, by `code` (unique per organization):

  | Voucher holding the `code` | Same values | Other values |
  |---|---|---|
  | none | `created` | `created` |
  | published, publishing or waiting for approval | `unchanged` | `conflict` (kept) |
  | DRAFT of an open batch, or created on its own | `unchanged` | `conflict` (kept) |
  | never-published DRAFT of an archived batch | `unchanged`, moved to this batch | `replaced`, moved to this batch |

  `error` (`INVALID` with the `field`, or `DUPLICATE_IN_BATCH` for a code used twice in one request) writes nothing. Values are compared after normalizing both sides: a missing field is its default, dates as instants, `discountValue` as an amount (`"20"` = `"20.00"`), `terms` and `metadata` with sorted keys. `conflict` and `replaced` list `differences: [{ field, stored, sent }]`. A concurrent insert of the same code is classified the same way, never a 500.
- **Activate:** the program check is made once (422 for the whole call); an archived batch is a 409. Then each voucher, in its own savepoint, with the checks of a single activation made now: `publishing`, `pendingApproval` (approval required and the caller is not an Owner, OCT-59: a Business Developer's batch activation is its submission), `skipped` (already published, publishing or waiting: calling it again is safe) or `failed` with a `reason` (under 24 hours left, no supply). The batch row is locked first, so an archive cannot race it. The worker publishes a few vouchers per poll (`CHAIN_SUBMIT_BATCH_SIZE`), so a 100-voucher batch takes minutes to be live.
- **Approve / reject a batch (Owner):** each voucher waiting for approval is decided as `reviewVoucher` decides one: approving starts publishing after the same checks made now (`publishing`, or `failed` with the reason), rejecting returns it to `DRAFT` with the reason (`rejected`, 1–500 characters). Others are `skipped`. Approving an archived batch is a 409, as activating it is; rejecting what it still has waiting is allowed. The program check is made once (422).
- **Pause / resume a batch:** through `updateVoucher`, so each voucher gets the rules of pausing or resuming it alone. Pausing takes `ACTIVE` vouchers and ones still publishing (they stay paused once live); resuming takes `PAUSED` ones already published, and needs no approval. Others are `skipped`. It works on an archived batch too: archiving doesn't stop claims.
- Every batch action runs on the batch's vouchers in `code` order, each in its own savepoint after locking the batch row (`eachBatchVoucher`), and returns `VoucherBatchActionResponse`: the batch, then each voucher's `outcome` (`publishing`, `pendingApproval`, `rejected`, `paused`, `resumed`, `skipped`, `failed` with a `reason`).
- **Archive:** one-way (no un-archive). Hidden from `GET` unless `?includeArchived=true`, can't be activated, and its never-published drafts' codes may be taken over by a later batch. Its live vouchers are not affected.
- `voucher_import_batches` (optional `name`, up to 120 characters, trimmed, not unique; source `CONSOLE`/`API`, created by a user or an API key, `archived_at`, RLS by organization); `vouchers.import_batch_id` is a composite key with `organization_id`, so a voucher can only belong to a batch of its own organization. `VoucherDto.batchId` shows it.
- `voucher-use.service.ts`: customer-signed use: prepare with an API key, finalize with the customer's signature.
- `voucher-terms.ts`: the canonical bytes frozen on-chain as a voucher's promise.
- `voucher-validation.ts`: runtime create/edit validation; merged edits are validated while the voucher row is locked.
- `rewards.module.ts`: Nest provider composition.

Persistence is `infra/db/repositories/rewards.repository.ts`; HTTP is `api/rest/rewards.controller.ts` and `api/rest/voucher-batches.controller.ts` (API key), `api/rest/console-rewards.controller.ts` and `api/rest/console-voucher-batches.controller.ts` (console session).
Every repository method runs under an organization's RLS context (`withTenant`), so Postgres hides other organizations' `vouchers` and `voucher_ownerships`. Request paths pass the authenticated organization (`findVoucherById(organizationId, id)`, …); only worker and indexer callbacks that start from an id read that row's organization first. The organization and member check of a claim or use runs as the connection's own role at its usual point (`asOwnRole`), since the tenant role cannot read `organizations` (OCT-289).

## What lives where

| What | Source of truth | PostgreSQL's part |
| --- | --- | --- |
| Terms, price, validity | Frozen `voucher_terms::VoucherTerms` | Copy on `vouchers`, for search and display |
| One customer's voucher and its status | A record in that member's `CreditAccount` | `voucher_ownerships`, a projection |
| Catalog stock, drafts, pausing new claims | `vouchers` | Itself |
| Serial codes | `voucher_ownerships` | A lookup, never proof of anything |

## What OctaP guarantees, and what it can't

OctaP runs the whole voucher lifecycle: catalog, stock, claims, grants and use all go through its API, so a merchant needs no voucher database of its own. The merchant decides the offer, shows the catalog in its own channels and layout, and applies the benefit at checkout from `discountType`, `discountValue` and the conditions in `terms`.

Every point a customer spends is tied to what it bought, and the customer agrees to that by signing. A voucher claim is tied to its frozen terms. A POS redemption is tied to the order and discount hashed into its reference (`posRedemptionReference`). A voucher also stays usable for at least 24 hours after it is claimed or granted, counted from its own deadline (see Validity).

The chain can't make a merchant deliver an off-chain benefit. If a merchant refuses a valid voucher, or gets the customer's signature on `use_voucher` and then withholds the discount, the chain is the evidence for the dispute. Resolving it is OctaP policy; cancelling an unused voucher refunds its points. Core also holds each program's `IssuerCap`, so customers trust OctaP not to grant, cancel or reverse on its own. Each of those is a public on-chain event.

## Publishing

A voucher is `ACTIVE` only once the chain holds its terms. Asking for `ACTIVE` sets `publishStatus: PUBLISHING`, snapshots the current refund policy into the voucher, and queues `VOUCHER_TERMS_PUBLISH` for the worker. On success the voucher becomes `PUBLISHED` and `ACTIVE`; a voucher paused meanwhile stays paused. On failure it becomes `FAILED`, can be edited, and can be activated again.

From `PUBLISHING` on, `code`, `title`, `description`, `pointsCost`, `discountType`, `discountValue`, `terms`, `startsAt`, `expiresAt` and `validForDays` cannot change, because they are the promise. A different offer is a new voucher. Supply, `perMemberLimit`, metadata and pausing stay editable.

`terms` is the merchant's own free-form object, which replaces `discountType` when the benefit fits no OctaP type. `buildVoucherTermsBytes` stores it with the other fields as canonical JSON, at most 8192 bytes. It is public on-chain, so it must hold no personal data.

## Validity

`startsAt`/`expiresAt` are the claim window. Without `validForDays`, `expiresAt` is also when every customer's voucher expires. With `validForDays` (1 to 3650, OCT-291), each customer's voucher is usable that many days from when it was issued to them, capped by `expiresAt`: `min(issued + validForDays, expiresAt)`. A welcome voucher open all year with `validForDays: 14` gives a customer who joins on 3 March until 17 March, and one who joins on 20 August until 3 September.

The chain holds it as `VoucherTerms.use_duration_ms` and checks `use_voucher` against the record's own `issued_at_ms` (`voucher_terms::use_deadline_ms`). In PostgreSQL each customer's deadline is `voucher_ownerships.expires_at`, computed by `voucherUseDeadline` (`@octap/contracts`). It is set provisionally when the voucher is reserved, and set again when the voucher becomes AVAILABLE, from the `issued_at_ms` that `VoucherGranted` / `VoucherClaimed` carry (`voucherIssuedAt`). Every confirming path reads it from the chain, whether the worker, the reconciler, POS finalize or the indexer, so the two deadlines match however late Core confirms. For a paid claim the chain issues the voucher when the customer signs, up to 30 minutes after the reservation, so the signing wait never shortens the customer's time. The final deadline goes out as `expiresAt` on `voucher.granted`, or as `voucher.expiresAt` on a paid claim's `credits.redemption.confirmed`; the claim or grant response only had the provisional one. The use check, refunds and member voucher lists all read `voucher_ownerships.expires_at`. Issuing still needs 24 hours of use left: `min(now + validForDays, expiresAt) - now`, which with `validForDays ≥ 1` is the same check on `expiresAt` as before.

## Issuing

Paid claims reuse the customer-signed pipeline under their own durable command type, `VOUCHER_CLAIM_RESERVE`, calling `credit_account::claim_voucher`. Move takes the price from the frozen terms, debits points, and records the voucher in one transaction. It still emits `CreditRedeemed` under the same reference, so the indexer and reversal paths are the ones POS uses.

A free claim and `POST /v1/rewards/vouchers/:id/grant` use `VOUCHER_GRANT`: the worker calls `grant_voucher` with the `IssuerCap`, opening the member's account first if needed. The customer spends nothing, so no customer signature is needed. The voucher stays RESERVED until the chain confirms, and `voucher.granted` reports it. A failed grant cancels the voucher and returns its unit.

## Using

Only the customer can mark a voucher used:

1. `POST /v1/rewards/vouchers/use` takes the serial and an idempotency key, and returns bytes. It accepts `VOUCHER_USE_RESERVE` and marks nothing used.
2. The customer's device signs, and `POST /v1/rewards/vouchers/use/finalize` sends it. The route is public: the signature is the authorization.
3. On the chain's verdict `credit_account::use_voucher` has run. The voucher becomes REDEEMED and `voucher.redeemed` is queued. Deliver the benefit on that event.

Exactly one AVAILABLE -> REDEEMED transition queues the webhook, whichever of finalize, the reconciler or the indexer gets there first. The indexer also applies a use with no command behind it: the customer signed it and the chain recorded it.

A new key replaces an unsigned use, so a customer who declined can be asked again. Otherwise the reconciler ends it after 30 minutes. Either way the voucher stays AVAILABLE. A failed Enoki execute keeps its digest, so that voucher waits for the reconciler until the transaction's expiration epoch passes. A voucher's serial is a lookup key: knowing it does not let anyone use the voucher.

## Paid claim details

`POST /v1/rewards/vouchers/:id/claim` requires a stable idempotency key for a paid reward. In one PostgreSQL transaction it locks catalog stock and the member balance, creates a PENDING REDEEM, holds points in `pendingRedemption`, reserves supply and creates a RESERVED ownership. It does not debit `confirmedBalance`, consume live buckets or emit a confirmation webhook yet. The response includes `transactionId`, `pointsCost`, `pointsDeducted: 0`, `digest` and `transactionBytes` for the customer's zkLogin/Enoki session to sign. Free rewards have nothing to sign; see Issuing.

The customer's device sends `{ digest, signature }` to the existing public `POST /v1/credits/redeem/finalize` endpoint. Only the customer's chain-verified signature authorizes spending; merchant keys stay on trusted servers. A successful chain verdict, indexer event, or digest reconciliation atomically debits the point projection, consumes buckets, releases the point hold and activates the ownership. The existing `credits.redemption.confirmed` outbox event includes the chain digest. A RESERVED serial cannot be redeemed. `GET /v1/rewards/claims/:ownershipId` reads the tenant-scoped persisted state after asynchronous recovery; retrying claim also returns its current state.

The chain reference is `voucher-claim-<ownershipId>`, allowing the existing indexer and `reverse_redeem` path to match the claim.

### Reversing a claim

A merchant reverses a paid claim through `POST /v1/credits/transactions/:transactionId/reverse` on its REDEEM transaction. Refund eligibility uses the immutable policy snapshot taken when the coupon was claimed. With the default policy, the points and coupon move together:

| Coupon when reversed | Result |
| --- | --- |
| RESERVED | Not reversible: the transaction is still PENDING. Failure or abandonment releases it instead. |
| AVAILABLE, not past its expiry | The coupon is CANCELLED, its unit returns to the catalog (a DEPLETED voucher becomes ACTIVE again) and the points are refunded, in one transaction. The worker mirrors it with `cancel_voucher`. |
| Any, with a use in flight | 409. The customer may already have signed it, so the refund waits until the use settles. |
| REDEEMED | 409. The benefit was delivered, so nothing changes. To compensate the member, issue an earn with its own reason. |
| EXPIRED, or AVAILABLE past its expiry | 409. The benefit lapsed under the voucher's terms; same as REDEEMED. |

The reversal locks the voucher row before cancelling the coupon, as redemption does, so a coupon used at checkout while it is being reversed ends up either REDEEMED with the points kept or CANCELLED with the points refunded, never both. Configured policies may also allow refunds of redeemed or expired coupons; any `write` credential may then make them, since the policy is the only gate. These preserve REDEEMED/EXPIRED and never replenish stock. Free claims have no REDEEM transaction and so cannot be reversed. Existing reversal limitations documented in the roadmap still apply.

On-chain, an unused voucher is refunded with `cancel_voucher`, which cancels it and refunds its points together. `reverse_redeem` refuses one. A used voucher's policy-allowed refund goes through `reverse_redeem` and stays used. A granted voucher cannot be cancelled by anyone: nothing was paid, so the issuer has nothing to return.

Definitive chain failure cancels the ownership and releases stock and points together. An unsigned claim is abandoned after 30 minutes by the worker reconciler or lazily on a balance read, POS reserve or another voucher claim. Both paths cancel reserved coupons and return their stock in the same transaction as releasing the point hold. Continuing the same unsigned claim refreshes its abandonment clock. The expiration path locks and rechecks the operation before releasing anything, so it cannot release a claim concurrently submitted by finalize. Submitted digests remain reserved until their outcome is known, including after Redis cache expiry. A different digest cannot replace an already-submitted digest. Sponsorship errors leave the durable reservation retryable with the same key; otherwise the unsigned-claim timeout releases it.

A changed voucher/member payload under the same organization-scoped key returns 409. Concurrent claims cannot oversell stock or spend points held by another voucher/POS request. How many non-cancelled vouchers of one kind a member may hold is the voucher's `perMemberLimit` (null: no limit; OCT-291). Used and expired ones count, including after a refund: refunding a used or expired voucher keeps it REDEEMED or EXPIRED, since the member did get it. Cancelled ones (failed, abandoned, or refunded while unused) don't count, and remain auditable. The claim or grant counts them under the voucher's row lock, so two claims by one member can't both take the last slot; past the limit it is a 409. A retry under the same key returns the same ownership before the count, so it never consumes the limit. The limit is a commercial setting, so it stays editable after publishing, like supply. Migration `0025_voucher_per_member_limit` replaced the old one-per-member unique index and set `perMemberLimit = 1` on existing vouchers, so they behave as before. Historical pre-migration Postgres-only claims remain historical records; this change does not fabricate chain receipts or debit them again.

## Lifecycle

`POST /v1/rewards/vouchers` asks for ACTIVE by default and also accepts DRAFT or PAUSED. `PATCH /v1/rewards/vouchers/:id` edits permitted fields or sets DRAFT/ACTIVE/PAUSED. Both require a merchant `write` scope; reads require `read`. See Publishing for what becomes immutable.

Supply cannot fall below claimed count; an exhausted voucher, or one with less than 24 hours left before it expires, cannot be activated. Claims and grants need the same 24 hours of use left, which the contract enforces too (`voucher_terms::is_issuable`). Increasing exhausted supply requires explicit activation. Pausing prevents new claims but does not revoke already-issued vouchers or alter their benefit/expiry.

Dates must be real calendar dates in ISO date-time format with seconds and a timezone (for example `2030-01-01T00:00:00Z`). Impossible dates and out-of-range times are rejected. Numerically equivalent discount strings such as `10` and `10.00` represent the same benefit.

Claims and voucher use reject inactive organizations, blocked global identities or inactive organization members. An expired voucher cannot be used. The successful transition queues exactly one `voucher.redeemed` webhook in the same database transaction, retaining OCT-244's outbox guarantee.

## Configurable organization refund policies

This is separate from the Sui points policy. Settings are data in the append-only `voucher_refund_policies` table; `domain/rewards/refund-policy.ts` evaluates them. The reversal repository invokes that evaluator on the current coupon after locking its catalog and ownership rows. Eligibility, coupon state, catalog stock, points reversal and audit metadata commit or roll back together. The existing worker dispatch/reconciliation of the on-chain reversal is unchanged; its documented asynchronous reversal limitations still apply.

- `GET /v1/rewards/refund-policy` (`read`): latest settings for vouchers published from now on, or default version 0.
- `GET /v1/rewards/refund-policy/history` (`read`): history newest first; `limit` defaults to 50 (maximum 100), with an exclusive `beforeVersion` cursor.
- `PUT /v1/console/organizations/:organizationId/refund-policy` (console session, active Owner only): full replacement, appending a new version. The same console path also serves `GET` and `GET /history`, Owner only. A Business Developer is a 403 on all three. No API key publishes a policy (OCT-301): the policy alone decides which coupons a `write` key may refund, so only the Owner sets it.

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

All settings are required. `refundWindowDays` is null (no limit) or an integer from 1 to 3650, measured as elapsed days since claim; the boundary is exclusive. The default permits only unused/unexpired refunds, returns their stock, and has no time limit. A voucher takes the latest policy when it starts publishing and publishes it with its terms, so the chain holds the refund promise too. Every coupon of that voucher keeps it, returned as `refundPolicy` in claim and member-voucher responses. A policy update affects only vouchers published afterwards.

Publishing records the actor, timestamp and required reason. The actor is `createdByUserId`, the Owner who published from the console; versions an `admin` API key published before OCT-301 keep `createdByCredentialId` instead. A check constraint requires exactly one of the two. Neither has a foreign key, so the actor ID remains in history after that user or credential is removed. The Owner check runs inside the publishing transaction, after the organization row lock that also serializes versions, so concurrent publishers allocate distinct sequential versions. The policy table permits tenant-scoped SELECT and INSERT, not UPDATE or DELETE, for the application role. A refund records the applied policy, prior coupon state, decision, stock effect and refunding credential on the REVERSAL transaction, alongside the existing refund reason. The existing reversal unique index prevents a second refund of the same claim.

An allowed unused refund cancels the coupon; stock returns only when `restockUnused` is true. Setting it to false means each claim permanently consumes a limited campaign allocation, including cancellations; `claimedCount` therefore remains allocated. Use true when canceled inventory should become claimable again.

An allowed redeemed/expired refund preserves usage/expiry history and never returns stock, even if `restockUnused` is true. Refunding never reactivates a coupon or extends its expiry.

For example, `refundWindowDays: 1` permits a points refund strictly before 24 elapsed hours after claiming. This is not an appointment-relative deadline: returning a booking voucher when canceling at least 24 hours before an appointment needs appointment data and a separately designed reactivation/reissuance operation. An explicit used-coupon refund is an exceptional service recovery action, such as a benefit delivered incorrectly; it retains the delivered-benefit history, and the Owner opts into it with `allowRedeemed`.

RESERVED and CANCELLED coupons remain ineligible under every policy. Approval queues, staff-role rules, expiry extensions and reissuance are not provided by these endpoints. A `write` credential refunds whatever the coupon's snapshot allows, redeemed and expired coupons included, judged on the locked coupon state; an expired AVAILABLE coupon counts as expired. There is no separate scope for these refunds: the `admin` scope was retired in OCT-301, and a legacy key that still lists it gains nothing from it.

Node SDK: `getVoucherRefundPolicy`, `listVoucherRefundPolicyHistory(query?, options?)`; both accept `RequestOptions`. `setVoucherRefundPolicy` was removed in 0.2.0. Never put an API key in a browser.

Apply migration `0013_voucher_refund_policies` after `0012_voucher_claim_reserve_command_type` and deploy the corresponding API/worker code together. Existing coupon data does not need to be reset for the migration.