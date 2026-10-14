# Feature roadmap

This file is the single place that lists planned work. The source tree only contains code that
runs; there are no empty placeholder classes. If a feature is not under **Implemented**, it does
not exist yet, whatever the design documents say.

When you start an item, create its folder/files following [the implementation guide](implementation-guide.md),
then move the row to **Implemented** in the same pull request.

## Implemented

| Feature | Where |
| --- | --- |
| PostgreSQL (Supabase) connection, Drizzle schema, first migration, RLS helper | api/src/infra/db; api/db/postgres/migrations |
| Earn and redeem points, balance and transaction history | api/src/domain/credits; api/src/api/rest/credits.controller.ts |
| Voucher create/list/get/claim/redeem, member vouchers | api/src/domain/rewards; api/src/api/rest/rewards.controller.ts |
| Points and voucher wire types | ts-sdks/packages/contracts |
| Merchant Node client (REST) for points and vouchers | ts-sdks/packages/node |
| Browser client for balance and voucher claim | ts-sdks/packages/browser |
| Unit tests for credits/rewards services and SDK clients | scripts/test-unit.mjs |
| Sui Move: capabilities, program_control, policy_version, credit_account (earn/redeem, expiry-bucket FIFO) | contracts/sui/sources; tests under contracts/sui/tests |
| Move-generated TS bindings (`@mysten/codegen`) + chain client | ts-sdks/packages/chain |
| Earn lands on Sui: durable PG command → outbox → worker dispatch → on-chain confirmation | api/src/domain/credits/chain-submit.worker.ts, chain-submit.processor.ts; api/src/infra/clients/sui |

### Known gaps in implemented features

- Controllers fall back to a hard-coded organization id when the `x-organization-id` header is
  missing. There is no authentication or tenant check yet (see Identity/Authorization below).
- Only **earn** is chain-dispatched. **Redeem stays PostgreSQL-only**: `credit_account::redeem`
  requires the beneficiary's own signature (Move-enforced, not a bug), which needs zkLogin
  (Identity, below) — a worker signing with the IssuerCap key would abort on-chain every time, so
  it isn't wired rather than wired wrong. See `api/src/infra/clients/sui/sui.client.ts`.
- The chain adapter is demo-scoped to **one program/policy/IssuerCap**, applied to every
  organization — those object ids are committed constants in
  `ts-sdks/packages/chain/src/constants.ts` (`TESTNET_OCTAP_DEMO_PROGRAM_CONFIG`; see that file's
  doc comment for why object ids aren't env vars), not something `.env.example` configures. Real
  per-organization program provisioning is the `domain/programs` row below, not built yet.
- An end user has no real Sui address yet (no zkLogin/identity binding), so the worker opens each
  `CreditAccount` under a placeholder address derived from the PG ownership row id
  (`chain-submit.processor.ts`'s `demoBeneficiaryAddress`) — nobody holds its private key. Fine for
  earn (no signature needed); must be replaced once Identity exists, since redeem will need it to
  be a real controllable address.
- `operation_key` anti-replay is PostgreSQL-only (idempotency key), not enforced on-chain yet; see
  `contracts/sui/README.md`'s note on `OperationShard`.

## Not started

Suggested location follows the existing pattern: `api/src/domain/<feature>` for services and
module, `api/src/api/rest/<feature>.controller.ts` for HTTP, `api/src/infra/...` for persistence
and vendor clients.

### API domains

| Feature | Suggested location | Notes |
| --- | --- | --- |
| Identity: login, sessions, Google zkLogin | domain/identity; infra/clients/enoki | Enoki keys stay backend-only |
| Authorization: tenant, role, scope, object checks | domain/authorization; api/guards | Needed before exposing more endpoints |
| Organizations and subdomains | domain/organizations | Schema exists in organizations.schema.ts |
| Members: enrollment, identity binding | domain/members | Schema exists in members.schema.ts |
| Programs: program controls and capabilities | domain/programs | Paired with Move program_control |
| Policies: versions and preview | domain/policies | Paired with Move policy_version |
| Credits: reversal/cancellation | domain/credits/reversal.service.ts | Receipt-referenced |
| Credits: expiry and clawback | domain/credits/expiry.service.ts + expiry worker | Chain-time expiry |
| Operations: durable command, idempotency, outbox, UNKNOWN recovery | domain/operations; infra/db/repositories | Schema exists; a minimal claim/markSubmitted/markFailed slice exists as `infra/db/repositories/operations.repository.ts` for chain-submit dispatch only — no dedup beyond the idempotency key, no replay, no UNKNOWN recovery |
| Campaigns: draft, preview, approval | domain/campaigns | Executes only an approved immutable manifest |
| Developer: API keys, scopes, sandbox, request logs | domain/developer | |
| Merchant webhooks: signed delivery | domain/webhooks; infra/clients/merchant-webhooks | Node SDK verification helper |
| Billing: Stripe test billing, reconciliation | domain/billing; infra/clients/stripe | Schema exists in billing.schema.ts; distinct from points |
| Analytics: derived analytics export | domain/analytics; infra/clients/clickhouse; api/db/clickhouse | Analytics-only store |
| Audit: export, Walrus/Seal evidence, verifier | domain/audit; infra/clients/walrus, seal | Outside checkout path |
| Notifications | domain/notifications | |
| Administration: platform governance | domain/administration | |
| Indexer: Sui checkpoint ingestion, cursor, replay | domain/indexer; infra/clients/sui | |

### Workers

Each worker lives next to its feature as `<job>.worker.ts` (consumer lifecycle) and
`<job>.processor.ts` (one job through domain services), registered only in `api/src/worker.module.ts`.
A queue adapter goes in `infra/queue` when the first worker needs one.

| Job | Feature |
| --- | --- |
| Transaction submission to Sui (earn only — see known gaps) | credits (implemented: chain-submit.worker.ts) |
| Bucket expiry | credits |
| Projection from chain to PostgreSQL | operations |
| Checkpoint ingestion/replay | indexer |
| Webhook delivery | webhooks |
| Analytics export | analytics |
| Audit export | audit |
| Billing reconciliation | billing |
| Notification delivery | notifications |

### Cross-cutting API

| Feature | Suggested location |
| --- | --- |
| Validated configuration loading | api/src/config |
| Logs, tracing, metrics, worker lag | api/src/observability |
| Request validation pipes, error filters, interceptors | api/src/common or api/src/api |
| Redis cache and realtime push | infra/cache; infra/realtime |
| gRPC transport (server and Node SDK) | api/src/api/grpc; ts-sdks/packages/node/src/transports |
| OpenAPI / protobuf contracts | ts-sdks/packages/contracts |

### Sui Move contracts (contracts/sui/sources)

Object map from the design: `capabilities`, `program_control`, `policy_version`, `credit_account`
(**implemented**, see Implemented above and `contracts/sui/README.md`), `budget_shard`,
`operation_shard`, `operation_receipt`, `campaign_authorization`, `audit_manifest` (not started).
Add each remaining module with its tests under `contracts/sui/tests`.

### SDKs

| Feature | Package |
| --- | --- |
| Customer login (zkLogin) helper | browser |
| Customer transaction signing | browser |
| Offline earn-intent buffering | browser |
| Webhook signature verification | node |
| Deadlines and retries | node |
