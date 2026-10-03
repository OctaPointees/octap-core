# Credits domain

Earn, beneficiary-authorized redemption, expiry, reversals and clawback.

- `credits.service.ts`: main use-case coordination slot.
- `earn.service.ts`: Earn use-case coordination after merchant sale validation.
- `redemption.service.ts`: Customer-signed redemption coordination.
- `reversal.service.ts`: Receipt-referenced cancellation and reversal coordination.
- `expiry.service.ts`: Chain-time expiry and clawback coordination.
- `credits.module.ts`: Nest provider composition.

Workers and processors, when present, belong to this domain. A worker owns job lifecycle;
a processor coordinates a single job through application services. These classes are empty.
Persistence implementations belong in `../../infra/db/repositories/`; external clients in
`../../infra/clients/`. Domain services own rules and import domain ports, never controllers.
Add reviewed DTOs/types, rules and repository method contracts alongside their owning domain
when implementing a use case. No business behavior or authorization is implemented.
