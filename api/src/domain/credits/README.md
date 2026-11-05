# Credits domain

Loyalty points for an organization's end users.

- `credits.service.ts`: balance snapshot and transaction history.
- `earn.service.ts`: earn points, idempotent on `idempotencyKey`; a changed request under a used key is a 409.
- `pos-redemption.service.ts`: shared customer-signed on-chain redemption lifecycle for POS and paid voucher claims. Reserve points first, sponsor bytes, obtain the customer's signature and finalize. Rewards reserves its stock/ownership and points atomically before calling the shared sponsorship method. Only a chain verdict activates a paid voucher and debits the confirmed projection.
Unsigned POS/voucher holds are released after 30 minutes on the next balance read or POS reserve; voucher claims also have worker recovery. Cleanup cancels reserved coupons and returns stock in the same transaction. Holds with a submitted digest are left to chain reconciliation.

- `reversal.service.ts`: reverses a CONFIRMED earn/redeem exactly once (`reverses_transaction_id`
  is unique), idempotent on its own `idempotencyKey`. Letting `confirmedBalance` go negative is
  the clawback debt when an earn was already spent — there's no separate debt ledger. If the
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
The write transactions (`recordEarnTransaction`/`reservePosRedemption`/
`recordReversalTransaction`) run through `infra/db/rls.ts`'s `withRls()`, so Postgres RLS is a
real second line of defense on `loyalty_transactions` here, not just the app-code tenant checks
in `credits.service.ts`/`earn.service.ts`/etc. Read paths don't go through `withRls()` yet (see
the roadmap's known gaps). `reservePosRedemption` also runs through `withRls()`; `confirmPosRedemptionOnChain`/`failPosRedemptionOnChain` don't — same known gap as `confirmEarnOnChain`/`failEarnOnChain`, worker/callback-only paths not yet converted.
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
`credits.earned` contains purchase/estimate fields; `credits.earn.confirmed.pointsAmount` is actual points.
POS reserve and reversal still use real `pointsAmount` values.

An earn the owning budget shard cannot cover gets 422, using a best-effort read of the chain that ignores earns in flight. An accepted earn that later fails sends `credits.earn.failed` with `failureCode`; its key stays used, so another attempt needs a new key.

`BudgetWarningWorker` checks every active program every `BUDGET_WARNING_POLL_INTERVAL_MS` and sends `budget.low` once per crossing of 80% or 95% used.

`GET /v1/credits/budget` (`read` scope), `GET /v1/console/organizations/:id/budget` (any member) and `GET /v1/platform/organizations/:id/budget` (System Admin) return the live issuance budget.

`GET .../balance?programId=...` accepts the tenant's program row ID or its on-chain program-control ID;
a different program returns 404 rather than silently reading another balance.
