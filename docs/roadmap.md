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
| CORS enabled (permissive) so a separately-hosted frontend can call the API | api/src/main.ts |
| Tenant authorization: API-key auth (`Authorization: Bearer`), scopes, credential issue/revoke/rotate | api/src/infra/auth; api/src/api/rest/api-credentials.controller.ts |
| Credits: reversal of a CONFIRMED earn or redeem, idempotent, at most once, with clawback debt | api/src/domain/credits/reversal.service.ts |
| Webhooks: endpoint registration, signed delivery, retry/dead-letter/replay, Node SDK verifier | api/src/domain/webhooks; ts-sdks/packages/node/src/webhooks.ts |
| Authorization hardening: per-credential rate limiting, opt-in HMAC request signing with replay/nonce protection, RLS actually enforced on the earn/redeem/reversal write path | api/src/infra/auth; api/src/infra/cache; api/src/infra/db/repositories/credits.repository.ts |
| Identity: Google zkLogin via Enoki (address resolution, end-user binding, org enrollment), sponsored-transaction boundary for the future customer-signed redeem | api/src/domain/identity; api/src/infra/clients/enoki; api/src/infra/clients/sui/sui-transaction-builder.client.ts |
| Operations: durable-command acceptance with payload-hash conflict detection, reusable across features; UNKNOWN-state recovery for operations a crashed worker left stuck in PROCESSING | api/src/infra/db/repositories/operations.repository.ts (`acceptCommand`, `recoverStaleProcessing`) |

### Known gaps in implemented features

- Only **earn** is chain-dispatched. **Redeem stays PostgreSQL-only**: `credit_account::redeem`
  requires the beneficiary's own signature (Move-enforced, not a bug) — a worker signing with the
  IssuerCap key would abort on-chain every time, so it isn't wired rather than wired wrong. See
  `api/src/infra/clients/sui/sui.client.ts`. Identity (below) now resolves a real zkLogin address
  and can build+sponsor the redeem transaction kind, but nothing calls that from the actual
  redemption flow yet — wiring it to `RedemptionService` plus the Postgres ownership/balance
  update is OCT-55.
- Identity's login/enroll endpoints are intentionally public (no `@Tenant()`/`@Scopes()`): the
  Google id_token is the proof of identity, and Enoki validates it, not this process. No customer
  session/bearer token is issued — balance and voucher reads still require the merchant API-key
  guard until a real customer-session mechanism is separately scoped. The ephemeral keypair for
  signing is entirely client-side (this process only ever sees its public half); nonce/proof
  endpoints are thin Enoki passthroughs with no local cryptography.
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
- `acceptCommand`'s payload-hash conflict only guards against this process accepting two
  different payloads under one key — `EarnService` already short-circuits on a repeated
  idempotency key earlier (at the `loyaltyTransactions` level), so in practice this conflict
  path isn't reachable through today's one real caller; it exists for the next caller that
  doesn't have its own equivalent check. A conflict also isn't mapped to a clean HTTP 409 yet —
  it surfaces as an uncaught error, since no caller can trigger it through the HTTP layer today.
- `recoverStaleProcessing` only *detects and surfaces* a stuck operation (flips it to UNKNOWN,
  logged at worker startup) — there is no replay/resolution flow yet. An UNKNOWN operation stays
  UNKNOWN until someone checks the chain by hand and updates the row; auto-resubmitting it would
  risk the exact "second business effect" durable commands exist to prevent.
- `claimNextPending` is one conditional `UPDATE` per candidate row (documented in its own doc
  comment), not a batched `SKIP LOCKED` claim — fine for today's single-worker demo only.
- Webhook delivery is only wired into `EarnService`/`RedemptionService`; `ReversalService` and
  `RewardsService` don't call `WebhookDeliveryService.emit()` yet — same one-line pattern, not
  done here to keep this change reviewable. `emit()` is also not in the same DB transaction as the
  write that triggers it (a crash in between would silently drop the event), and the endpoint
  `secret` is stored as plaintext, not via a secrets manager/KMS — both are known, deliberate gaps,
  not oversights; the first needs the OCT-43 outbox generalized to cover this too.
- Reversal's "clawback debt" is just letting `confirmedBalance` go negative, which already blocks
  further redemption via the existing balance check — there is no separate debt ledger, repayment
  plan, or collections flow. There is also no expiry-bucket model in Postgres at all yet (that's
  still Move-only, see `credit_account.move`), so "retain original bucket and deadline semantics"
  does not apply to anything here: reversal only touches `confirmedBalance`/transaction status.
- No mTLS: deliberately not built at the app layer — there is no reverse proxy/Dockerfile in
  this repo yet to terminate TLS in front of it, and raw `https.Server` client-cert verification
  inside the Node process would be guessing at a deployment shape that doesn't exist. mTLS
  belongs at a proxy (nginx/Envoy/load balancer) forwarding a verified-identity header, when one
  gets introduced.
- HMAC request signing (`@RequireSignedRequest()`) is opt-in per route, applied so far only to
  `ApiCredentialsController`'s mutating routes — not every write route requires it yet.
- System-user (dashboard login) sessions are a separate, not-yet-started auth path from the
  API-key model entirely.
- RLS is enforced (`withRls()`, real `authenticated`/`service_role` roles and grants — see
  `docker/postgres-init`) only on `CreditsRepository`'s three REST-triggered write transactions
  (`recordEarnTransaction`/`recordRedeemTransaction`/`recordReversalTransaction`). The worker-only
  `confirmEarnOnChain`/`failEarnOnChain` callbacks (chain-submit path) still run on the plain
  pooled connection too — same gap, just not in scope here since this pass targeted the API's
  write path specifically. Every read path and all of
  `RewardsRepository`/`WebhooksRepository`/`ApiCredentialsRepository` still run on the plain
  pooled connection — RLS policies exist on their tables too, but nothing sets the session's
  tenant context for them, so they're protected only by application-code checks, not yet by the
  database as a second line of defense. Converting them is the same pattern, left for a follow-up
  to keep this change reviewable. `creditOwnerships` itself has no RLS policy at all (it's keyed
  by member, not by organization directly), so it relies on application code regardless of
  role/session context.

## Not started

Suggested location follows the existing pattern: `api/src/domain/<feature>` for services and
module, `api/src/api/rest/<feature>.controller.ts` for HTTP, `api/src/infra/...` for persistence
and vendor clients.

### API domains

| Feature | Suggested location | Notes |
| --- | --- | --- |
| Identity: system-user (dashboard login) sessions | domain/identity | Separate from the Google zkLogin flow implemented above; merchant/admin dashboard login, not the end-user customer identity |
| Authorization hardening: mTLS, rate limits, nonce/replay windows | api/src/infra/auth | Basic API-key/scope/tenant guard is implemented; see Known gaps above |
| Organizations and subdomains | domain/organizations | Schema exists in organizations.schema.ts |
| Members: enrollment, identity binding | domain/members | Schema exists in members.schema.ts |
| Programs: program controls and capabilities | domain/programs | Paired with Move program_control |
| Policies: versions and preview | domain/policies | Paired with Move policy_version |
| Credits: chain-time expiry buckets and worker | domain/credits/expiry.service.ts + expiry worker | Needs the Move `credit_account` bucket model mirrored into Postgres first; reversal/clawback-debt is implemented (see Implemented above), this row is only the bucket-expiry part |
| Campaigns: draft, preview, approval | domain/campaigns | Executes only an approved immutable manifest |
| Developer: API keys, scopes, sandbox, request logs | domain/developer | |
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
| Customer login (zkLogin) helper | browser — `loginWithGoogle()`/`enroll()` call the new identity endpoints, but obtaining the Google id_token itself (sign-in popup/button) is OctaP_Web's job, not this SDK's |
| Customer transaction signing | browser |
| Offline earn-intent buffering | browser |
| Webhook signature verification | node |
| Deadlines and retries | node |
