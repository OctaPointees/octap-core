# Programs domain

Per-organization on-chain program provisioning — the real replacement for the single shared
demo program every organization used to dispatch `earn` against.

- `programs.service.ts`: `provisionForOrganization()` creates a new `ProgramControl`, publishes
  and activates a `PolicyVersion`, and mints an `IssuerCap` for a given recipient address, then
  records the resulting object ids in Postgres (`infra/db/repositories/programs.repository.ts`).
  Idempotent at the Postgres level — a second call for an already-provisioned organization
  rejects instead of minting a duplicate program on-chain.
- Worker-only, registered directly in `worker.module.ts` (not `domain/domain.module.ts`, which
  `AppModule` also imports): it depends on `infra/clients/sui/program-admin.client.ts`, which
  holds `SUI_PROGRAM_ADMIN_PRIVATE_KEY` — an `AdminCap` signer with a much larger blast radius
  than the earn-only `IssuerCap` signer, so it must never reach the HTTP process.
- No HTTP endpoint yet: provisioning a program is a one-time per-organization setup action, not
  a per-request call, so it's invoked via `scripts/provision-program.mjs` (same pattern as
  `scripts/seed-dev-credential.mjs` for API credentials), not wired into `api/rest`.

Tenant isolation is enforced on-chain, not here: `contracts/sui/tests/credit_account_tests.move`'s
`earn_rejects_issuer_cap_scoped_to_a_different_program` proves an `IssuerCap` minted for one
program aborts (`EWrongProgram`) against another program's account, before this domain's code is
even reached.

**Known gap**: `domain/credits/chain-submit.processor.ts` still dispatches every organization's
`earn` against the one hardcoded `TESTNET_OCTAP_DEMO_PROGRAM_CONFIG` (`ts-sdks/packages/chain`),
not whatever this domain provisions. Provisioning a program here does not yet change which
program an organization's `earn` calls actually use — wiring `chain-submit.processor.ts` to look
up `ProgramsRepository` per organization instead of the shared constant is follow-up work, left
out here to keep this change reviewable and avoid touching the already-working demo earn path.
