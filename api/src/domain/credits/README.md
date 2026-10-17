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
Chain-time expiry buckets are not implemented yet (see the roadmap).
