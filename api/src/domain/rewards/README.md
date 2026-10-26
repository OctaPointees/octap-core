# Rewards domain

Merchant vouchers: create, list, edit, claim with points and redeem by serial code.

- `rewards.service.ts`: voucher use cases.
- `voucher-validation.ts`: runtime create/edit validation; merged edits are validated while the voucher row is locked.
- `rewards.module.ts`: Nest provider composition.

Persistence is `infra/db/repositories/rewards.repository.ts`; HTTP is `api/rest/rewards.controller.ts`.

## Consistency and ledger boundary

Voucher conversion is an off-chain PostgreSQL operation. Points deduction, bucket consumption, ownership creation, stock count, a saved claim response and `credits.redeemed` webhook deliveries share one transaction. Failure rolls all of them back. The claim locks stock and credit ownership so competing requests cannot oversell or overspend. No Sui redemption is dispatched; do not treat this flow as chain redemption or mix the synthetic demo balance with a live chain account. Chain/database reconciliation remains a separate design concern.

Spendable points exclude pending POS-redemption holds. Unsafe integer arithmetic is rejected rather than rounded. Expiry is rechecked after waiting on a credit lock. Duplicate reward codes and conflicting claims return 409, including under concurrency; a failed transaction does not consume points or stock. New serials use a 64-bit random suffix, while previously issued serials remain accepted.

Claim callers should send a stable `idempotencyKey`. The organization-scoped durable operation compares voucher/member payloads and returns the original claim response on replay, including after stock depletion, edits or redemption. A changed payload returns 409. Legacy callers without a key get a deterministic member/voucher key. The per-member rule is one ownership per voucher, even after use. Replays return the original response; use ownership reads to obtain its current status.

## Lifecycle

`POST /v1/rewards/vouchers` keeps the existing ACTIVE default and also accepts DRAFT or PAUSED. `PATCH /v1/rewards/vouchers/:id` edits permitted fields or sets DRAFT/ACTIVE/PAUSED. Both require a merchant `write` scope; reads require `read`.

After a claim exists, code, points cost, discount type/value and availability dates are immutable. Title/description/metadata, supply and claim availability can still be managed. Supply cannot fall below claimed count; an exhausted or expired voucher cannot be activated. Increasing exhausted supply requires explicit activation. Pausing prevents new claims but does not revoke already-issued vouchers or alter their benefit/expiry.

Dates must be real calendar dates in ISO date-time format with seconds and a timezone (for example `2030-01-01T00:00:00Z`). Impossible dates and out-of-range times are rejected. Numerically equivalent discount strings such as `10` and `10.00` represent the same benefit.

Claims and serial redemption reject inactive organizations, blocked global identities or inactive organization members. Expired ownership cannot be redeemed. Redemption locks the ownership and permits exactly one AVAILABLE → REDEEMED transition; a repeated use returns 400. The successful transition queues exactly one `voucher.redeemed` webhook in the same database transaction, retaining OCT-244's outbox guarantee.
