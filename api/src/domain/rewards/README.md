# Rewards domain

Merchant vouchers: create, list, claim (paid with points via `RedemptionService`) and redeem by serial code.

- `rewards.service.ts`: voucher use cases.
- `rewards.module.ts`: Nest provider composition; imports CreditsModule for point redemption.

Persistence is `infra/db/repositories/rewards.repository.ts`; HTTP is `api/rest/rewards.controller.ts`.
