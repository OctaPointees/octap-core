# Credits domain

Loyalty points for an organization's end users.

- `credits.service.ts`: balance snapshot and transaction history.
- `earn.service.ts`: earn points, idempotent on `idempotencyKey`; a changed request under a used key is a 409.
- `pos-redemption.service.ts`: shared customer-signed on-chain redemption lifecycle for POS and paid voucher claims. Reserve points first, sponsor bytes, obtain the customer's signature and finalize. Rewards reserves its stock/ownership and points atomically before calling the shared sponsorship method. Only a chain verdict activates a paid voucher and debits the confirmed projection.
Unsigned POS/voucher holds are released after 30 minutes on the next balance read or POS reserve; voucher claims also have worker recovery. Cleanup cancels reserved coupons and returns stock in the same transaction. Holds with a submitted digest are left to chain reconciliation.

- `reversal.service.ts`: reverses a CONFIRMED earn/redeem exactly once (`reverses_transaction_id`
  is unique), idempotent on its own `idempotencyKey`. An earn is reversible only while its bucket
  is whole, not held by a pending redemption, and more than 10 minutes from expiry, the chain's own
  rule for `reverse_earn` with room for the worker's delay: otherwise a 409
  (OCT-334), so a reversal never drives the balance negative or diverges from the chain. If the
  original reached the chain (it has a `blockchainTransactionId`), the same transaction queues a
  `CREDIT_REVERSAL_CHAIN_SUBMIT` command, which `chain-submit.processor.ts` mirrors with
  `reverse_earn`/`reverse_redeem` (OCT-50); its digest is linked to the REVERSAL row once it lands.
- `chain-outcome.reconciler.ts` (worker-only, run by `chain-submit.worker.ts`): settles commands
  whose chain outcome was never learned — an earn whose `execute` threw, a POS finalize whose
  Enoki execute (or the wait after it) threw, or a worker that died mid-submit (OCT-52). Both
  paths record the transaction's digest and expiration epoch on the operation *before* sending,
  so this only ever asks the chain about that digest: success -> `confirm*OnChain`, failure or
  "not found and past its expiration epoch" -> release the hold, FAILED. It never sends anything.
- `credits.module.ts`: Nest provider composition.

Persistence is `infra/db/repositories/credits.repository.ts`; HTTP is `api/rest/credits.controller.ts`.
Every repository method runs under the member's organization's RLS context (`infra/db/rls.ts`'s
`withTenant()`, or `withRls()` for the original write transactions), so Postgres RLS is a real
second line of defense on `loyalty_transactions`, `credit_ownerships` and `credit_buckets`, not
just the app-code tenant checks in `credits.service.ts`/`earn.service.ts`/etc. Request paths pass the
authenticated organization (`getOrCreateCreditOwnership(organizationId, …)`, …); only worker and
indexer callbacks (`confirmEarnOnChain`, `failPosRedemptionOnChain`, …) start from an id, read that
row's organization, then run under it (OCT-289). Three lookups stay on the plain connection, marked
`RLS exception`: `findMemberOrganizationId`, `findCreditOwnershipBySuiAccountId`,
`hasAnyLoyaltyTransactions`.
Expiry mirrors `credit_account.move`'s buckets (OCT-49): each confirmed earn writes a
`credit_buckets` row with the chain's `bucket_expires_at_ms`; voucher and POS redemptions consume
buckets nearest-expiry first; `expireDueBuckets` forfeits due ones (one EXPIRY transaction per
sweep) before every balance read or spend, so an expired bucket never counts even before the
chain emits `CreditExpired`.

`chain-submit.processor.ts` opens each member's `CreditAccount` under their real zkLogin address
(`CreditsRepository.findBeneficiaryAddress`, via `domain/identity`) — not a placeholder, since a
wrong address at open time can never be corrected later (`credit_account.move`'s `beneficiary` is
set once, no entry point changes it).

## Earn purchase contract

`POST /v1/credits/earn` takes `purchaseAmount` (a positive safe integer in the program currency's
minor unit), not a point count. At acceptance the active program's `earnBps` determines
`floor(purchaseAmount * earnBps / 10000)` using integer arithmetic; a purchase that rounds to zero
is rejected with 400, because the chain would abort it. The PENDING transaction and `pendingEarn`
contain that point estimate. The response returns `purchaseAmount`, `estimatedPoints` and
`pointsEarned: null`. Pending history returns `pointsAmount: null` and `estimatedPoints`.
Only the chain-confirmed amount becomes `pointsEarned`/history `pointsAmount` and spendable balance.
Failure releases the estimate without crediting it; confirmation releases the estimate and credits
the actual event amount, using the locked pending row.

For example, purchase 100000 at 100 bps reserves 1000 estimated points and confirms 1000 points.

An earn may name one campaign (`campaignId`, OCT-340; `campaign-boost.ts`). The campaign must be the
organization's, `ACTIVE`, within `[startsAt, endsAt]` and have a `multiplierBps`; otherwise the earn
is a 422, never earned at the base rate. Points are `floor(purchase * earnBps * multiplierBps /
10^8)`, the same formula `credit_account::earn` applies on-chain, with one floor over the whole
product: 100000 at 100 bps and 2x is 2000. The multiplier is fixed in the durable command when the
earn is accepted, so a campaign that closes before the worker submits still boosts what it accepted,
and `loyalty_transactions.campaign_id` records which campaign it was. A replay under the same key
skips the campaign check, as it skips the others; a replay with a different `campaignId` is a 409.
`credits.earned` contains purchase/estimate fields; `credits.earn.confirmed.pointsAmount` is actual points.
POS reserve and reversal still use real `pointsAmount` values.

An earn the owning budget shard cannot cover gets 422, using a best-effort read of the chain that ignores earns in flight. An accepted earn that later fails sends `credits.earn.failed` with `failureCode`; its key stays used, so another attempt needs a new key.

`BudgetWarningWorker` checks every active program every `BUDGET_WARNING_POLL_INTERVAL_MS` and sends `budget.low` once per crossing of 80% or 95% used.

`GET /v1/credits/budget` (`read` scope), `GET /v1/console/organizations/:id/budget` (any member) and `GET /v1/platform/organizations/:id/budget` (System Admin) return the live issuance budget.

`GET .../balance?programId=...` accepts the tenant's program row ID or its on-chain program-control ID;
a different program returns 404 rather than silently reading another balance.

## On-chain evidence (OCT-334)

`ledger-evidence.service.ts` shows that what Core records is what the chain holds. It is
read-only: a difference is reported, never corrected.

- **Organization history.** `GET /v1/credits/transactions` (`read`) and
  `GET /v1/console/organizations/:id/transactions` (Owner or Business Developer) list the
  organization's whole ledger, newest first. Each row carries its `blockchainDigest` and
  `confirmedAt`.
- **Account.** A balance carries `creditAccountId`, the member's `CreditAccount` object.
- **Program.** `GET …/program` reads the program's frozen `PolicyVersion` from the chain: its
  rules, and the transaction that published it. `policyStatus` is `MATCH` when those rules are
  the `earnBps`/`expiryMs` Core applies. The read is cached for an hour, since a frozen object
  never changes.
- **Balance reconciliation.** `GET …/members/:id/reconciliation` brings the recorded side up to
  date (expired buckets, abandoned holds), then compares `confirmedBalance` with the chain's own
  `credit_account::spendable`, called as a simulated transaction (nothing signed or executed).
  - `PENDING`: a pending amount or an unsettled durable command for the member means the two
    cannot be compared yet.
  - `MATCH` / `MISMATCH`: nothing is in flight, and the two are equal or not.
  - `UNAVAILABLE`: the chain could not be read.

  A member without a `CreditAccount` holds 0 on-chain. Answers are cached for 30 seconds,
  except `UNAVAILABLE`. A `MISMATCH` is logged at error level: since a spent earn can no longer be reversed, nothing in
  Core is expected to produce one.

