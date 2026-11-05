# Programs domain

Per-organization on-chain programs: provisioning them, and resolving the calling organization's
program for every chain dispatch. There is no shared or default program — an organization's earn
only ever runs against the program provisioned for it.

- `programs.service.ts`: `provisionForOrganization()` creates a new `ProgramControl`, publishes
  and activates a `PolicyVersion`, and mints an `IssuerCap` for a given recipient address, then
  records the resulting object ids in Postgres (`infra/db/repositories/programs.repository.ts`).
  Race-safe: the organization's `programs` row is reserved (`PROVISIONING`) *before* any chain
  call, so the unique index on `organization_id` admits exactly one concurrent caller — every
  other caller gets a `ConflictException` without minting anything. An on-chain failure releases
  the reservation for a retry; a DB failure after minting leaves it `PROVISIONING` (no duplicate
  mint) and logs the minted object ids for manual repair.
- Worker-only, registered directly in `worker.module.ts` (not `domain/domain.module.ts`, which
  `AppModule` also imports): it depends on `infra/clients/sui/program-admin.client.ts`, which
  signs with the program admin key (`SUI_PROGRAM_ADMIN_KMS_KEY_ID`; see `docs/kms-signer.md`) — an `AdminCap` signer with a much larger blast radius
  than the earn-only `IssuerCap` signer, so it must never reach the HTTP process.
- `topUpBudget()` refills an organization's issuance budget (`budget_shard::top_up`, signed by the
  same `AdminCap` key) when its budget shards drain, split across shards like the initial budget.
  `programs.total_budget` keeps the provisioning-time figure; the chain holds the live remaining.
  An approved `BUDGET_TOP_UP` change request is the only way to run it (`domain/administration`).
- No HTTP endpoint yet: provisioning a program is a one-time per-organization setup action, not
  a per-request call, so it's invoked via `scripts/provision-program.mjs` (same pattern as
  `scripts/seed-dev-credential.mjs` for API credentials), not wired into `api/rest`.

Tenant isolation is enforced on-chain, not here: `contracts/sui/tests/credit_account_tests.move`'s
`earn_rejects_issuer_cap_scoped_to_a_different_program` proves an `IssuerCap` minted for one
program aborts (`EWrongProgram`) against another program's account, before this domain's code is
even reached.

## Resolving an organization's program

`program-config.ts`'s `resolveProgramConfig(repo, organizationId)` is the single lookup every
chain dispatch path goes through (`ProgramsRepository.findByOrganization`, no second lookup). It
returns the row's `OctapProgramConfig` (`programControlId`, `policyVersionId`, `issuerCapId`,
`operationShardIds`, `budgetShardIds`) only for an `ACTIVE` row with all on-chain ids and a
non-empty, equal-length shard pair; anything else throws `ProgramNotProvisionedError`:

- `EarnService` and `PosRedemptionService.reserve` check it (via `requireProgramConfig`) before
  holding any points and map it to **HTTP 422** (`Organization <id> has no on-chain program
  provisioned (<reason>)`) — the request is rejected, nothing is recorded. Redeem resolves nothing
  further: `credit_account::redeem` takes only the member's `CreditAccount`, which was opened in
  (and records) its organization's program.
- `ChainSubmitProcessor` resolves it again from the operation's `tenantId` before any chain call
  (`openAccount` and `earn` both take the resolved config), so an operation that was accepted
  before its program disappeared fails cleanly (`FAILED`, reservation released) instead of
  writing into another organization's program.

Re-provisioning an organization that already has members is handled on their next earn
(OCT-244): their accounts are still in the old program, so `earn` aborts with `EWrongProgram`.
`ChainSubmitProcessor` then reads the account's on-chain `program_id` and reopens the account in
the current program only if that id really is a different program. The old account's credits are
not moved; see `docs/roadmap.md`. This is not the same as a package republish: there every
object, accounts included, belongs to the abandoned package, so `contracts/sui/DEPLOYMENTS.md`'s
manual reset still applies.

Reasons it rejects: no `programs` row, a row still `PROVISIONING`, a row missing on-chain ids, or
a row provisioned before OCT-41's shards (migration `0005` backfilled those with no shards — they
need re-provisioning). To onboard any organization, run `scripts/provision-program.mjs`.
