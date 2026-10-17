# Credits domain

Loyalty points for an organization's end users.

- `credits.service.ts`: balance snapshot and transaction history.
- `earn.service.ts`: earn points, idempotent on `idempotencyKey`.
- `redemption.service.ts`: redeem points, idempotent on `idempotencyKey`.
- `reversal.service.ts`: reverses a CONFIRMED earn/redeem exactly once (`reverses_transaction_id`
  is unique), idempotent on its own `idempotencyKey`. Letting `confirmedBalance` go negative is
  the clawback debt when an earn was already spent — there's no separate debt ledger.
- `credits.module.ts`: Nest provider composition.

Persistence is `infra/db/repositories/credits.repository.ts`; HTTP is `api/rest/credits.controller.ts`.
The three write transactions (`recordEarnTransaction`/`recordRedeemTransaction`/
`recordReversalTransaction`) run through `infra/db/rls.ts`'s `withRls()`, so Postgres RLS is a
real second line of defense on `loyalty_transactions` here, not just the app-code tenant checks
in `credits.service.ts`/`earn.service.ts`/etc. Read paths don't go through `withRls()` yet (see
the roadmap's known gaps).
Chain-time expiry buckets are not implemented yet (see the roadmap).
