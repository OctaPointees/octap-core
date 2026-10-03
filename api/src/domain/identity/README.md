# Identity domain

OctaP login identity, Google/zkLogin bindings, sessions and profile lifecycle.

- `identity.service.ts`: main use-case coordination slot.
- `zklogin.service.ts`: Google/zkLogin identity and proof/session orchestration.
- `identity.module.ts`: Nest provider composition.

Workers and processors, when present, belong to this domain. A worker owns job lifecycle;
a processor coordinates a single job through application services. These classes are empty.
Persistence implementations belong in `../../infra/db/repositories/`; external clients in
`../../infra/clients/`. Domain services own rules and import domain ports, never controllers.
Add reviewed DTOs/types, rules and repository method contracts alongside their owning domain
when implementing a use case. No business behavior or authorization is implemented.
