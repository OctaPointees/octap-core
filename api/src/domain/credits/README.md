# Credits domain

Loyalty points for an organization's end users.

- `credits.service.ts`: balance snapshot and transaction history.
- `earn.service.ts`: earn points, idempotent on `idempotencyKey`.
- `redemption.service.ts`: redeem points, idempotent on `idempotencyKey`.
- `credits.module.ts`: Nest provider composition.

Persistence is `infra/db/repositories/credits.repository.ts`; HTTP is `api/rest/credits.controller.ts`.
Reversal and expiry are not implemented yet (see the roadmap).
