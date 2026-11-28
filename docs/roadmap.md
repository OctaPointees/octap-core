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
| Earn from purchase amounts, customer-signed POS redeem, balance and transaction history | api/src/domain/credits; api/src/api/rest/credits.controller.ts |
| Voucher create/publish/list/get/claim/grant, customer-signed use, member vouchers. Terms are frozen on-chain and each customer's voucher is a record in their `CreditAccount` (OCT-279). A per-voucher `perMemberLimit` caps how many one member may hold, null for no limit, and `validForDays` makes each customer's voucher usable N days from its issue, capped by `expiresAt` (OCT-291). Organizations may require an Owner's approval before a Business Developer's or an API key's voucher goes live (`PENDING_APPROVAL`, OCT-59); the Owner approves, rejects or (while approval is required) activates only the version they reviewed, with a submission's terms kept as submitted, and every voucher records who created it and who took it live (OCT-324). Voucher batches: up to 100 vouchers created as one DRAFT batch with a `dryRun` preview and per-item results keyed by `code` (`created`/`unchanged`/`conflict`/`replaced`/`error`), then activated (an Owner's activation also approves), paused, resumed or archived (drafts become `ARCHIVED`) together, with an API key or from the console (OCT-303) | api/src/domain/rewards; api/src/api/rest/rewards.controller.ts; contracts/sui/sources/voucher_terms.move |
| Voucher expiry: `EXPIRED` is written once a deadline passes, a customer's voucher (`AVAILABLE → EXPIRED`, `voucher.member_expired`) at its own `expires_at`, a voucher (`ACTIVE`/`PAUSED`/`DEPLETED → EXPIRED`, `voucher.expired`) when its claim window closes; by `VoucherExpiryWorker` every 60 s and by the read that meets it first, so no read shows an expired voucher as usable. An `EXPIRED` voucher refuses a status change | api/src/infra/db/repositories/voucher-expiry.ts; api/src/domain/rewards/voucher-expiry.worker.ts |
| Console reward catalog: Owner/Business Developer list and detail, Owner-only create (DRAFT by default, `pointsCost` required), edit, pause and activate, from the Google session, checked in the write's transaction (OCT-236) | api/src/api/rest/console-rewards.controller.ts; api/src/domain/rewards/console-rewards.service.ts |
| Points and voucher wire types | ts-sdks/packages/contracts |
| Merchant Node client (REST) for credits, vouchers, webhook management, structured errors and cancellation | ts-sdks/packages/node |
| Browser auth SDK for merchant websites: Firebase-style Google sign-in, enrollment, session restore, zkLogin transaction signing and finalize, over Core's proxy routes. Live Testnet signing is verified by hand (`ts-sdks/examples/README.md`) | ts-sdks/packages/browser; ts-sdks/examples/browser-auth |
| Test layer: Vitest unit specs per domain/infra/SDK + integration specs against real Postgres/Redis (testcontainers), coverage-gated in CI | api/tests; ts-sdks/packages/*/tests; vitest.config.ts |
| Sui Move: capabilities, program_control, policy_version, credit_account (earn/redeem, expiry-bucket FIFO) | contracts/sui/sources; tests under contracts/sui/tests |
| Move-generated TS bindings (`@mysten/codegen`) + chain client | ts-sdks/packages/chain |
| Earn lands on Sui: durable PG command → outbox → worker dispatch → on-chain confirmation | api/src/domain/credits/chain-submit.worker.ts, chain-submit.processor.ts; api/src/infra/clients/sui |
| CORS enabled (permissive) so a separately-hosted frontend can call the API | api/src/main.ts |
| Validated configuration: every env var the API and worker read is checked at boot (`ENV_SCHEMA`), all problems reported at once; `DATABASE_URL` and the worker's issuer signer (plus the program admin signer when provisioning is enabled) are required; HTTP feature secrets may stay unset and are logged (OCT-60) | api/src/config; api/src/main.ts; api/src/worker.ts |
| Deploy image: one `Dockerfile` for the API, the worker, the migrations and the MCP server (the command picks the process, configuration from the environment only, no `.env` in the image); `scripts/migrate.mjs` applies the migrations and, on a Postgres without Supabase's roles (RDS), creates them first; CI builds the image, migrates an empty Postgres twice and checks the API's `/health` (OCT-317). On a managed Postgres (RDS), whose admin is not a superuser, `service_role` is created without `BYPASSRLS`, which nothing in Core uses (OCT-319). Not deployed anywhere yet: OCT-316 | Dockerfile; scripts/migrate.mjs; docker/postgres-init/01-supabase-compat.sql; .github/workflows/check.yml |
| Observability: a server-generated correlation id per HTTP request (`request.correlationId`, `X-Request-Id` header, access log line); public deep `/health` (database, Redis, Sui RPC; 503 only when the database or Redis is down); platform-admin `/v1/platform/health` with probe errors and worker lag (unsettled command outbox age per command type, webhook backlog, indexer checkpoints behind the chain) (OCT-60) | api/src/observability; api/src/api/rest/health.controller.ts; api/src/infra/db/repositories/operational-health.repository.ts |
| OpenAPI document for every REST route (paths, params, auth per route read from the guards' metadata), Swagger UI at `/docs` behind `OPENAPI_ENABLED`, request/response/query schemas generated from each handler's TypeScript types, committed `docs/openapi.json` (3.1) checked in CI (OCT-285) | api/src/api/openapi; scripts/openapi*.mjs; docs/openapi.json |
| Developer request log: every call an API key makes (method, route template, path, status, latency, category, correlation id, a failed call's error body, user agent), recorded after the response and kept 30 days; the Owner and Business Developers read it from the console as a filterable list, one call by `X-Request-Id`, a live tail, a RED summary (rate, errors, p50/p95/p99 per category, endpoint and key), a time series and grouped errors (OCT-298) | api/src/domain/developer; api/src/api/rest/console-request-logs.controller.ts; api/src/infra/db/repositories/request-logs.repository.ts |
| Developer sandbox mode: SANDBOX API keys (`octap_test_…`, fixed at issue, a Business Developer may create a sandbox write key) earn and redeem against a separate sandbox ledger (`sandbox_credit_balances`, `sandbox_loyalty_transactions`) with live validation and response shapes plus `isSandbox: true`: earns confirm at once with a synthetic `sandbox_…` digest, a redemption finalizes with any signature, and nothing reaches `credit_ownerships`, the outbox, a durable command, Enoki or the chain. `ApiKeyGuard` refuses a sandbox key on every write route not marked `@SandboxSupported()` (403 `SANDBOX_NOT_SUPPORTED`) (OCT-297) | api/src/domain/sandbox; api/src/infra/auth/api-key.guard.ts; api/src/infra/db/repositories/sandbox.repository.ts |
| On-chain evidence (OCT-334, for OCT-328): the organization's points history (`GET /v1/credits/transactions`, console `…/transactions`; filter by type, status, member), every transaction's digest and `confirmedAt`, the member's `creditAccountId` on their balance, the program with its frozen on-chain policy compared with the rules applied (`…/program`, `policyStatus`), and a member's balance reconciled live against `credit_account::spendable` (`…/members/:id/reconciliation`: MATCH / PENDING / MISMATCH / UNAVAILABLE, cached 30 s). Read-only, for API keys and the console's Owner and Business Developers | api/src/domain/credits/ledger-evidence.service.ts; api/src/api/rest/console-ledger.controller.ts; ts-sdks/packages/chain/src/client.ts |
| Audit log (OCT-333): who did what, durably. One append-only `audit_log` row per change, in the change's own transaction, with the actor taken from the request context (API key, console user, or SYSTEM outside a request): every outbox event recorded in an authenticated request, plus API key, webhook endpoint (origin only) and delivery, member, voucher edit, staff, invitation, first-Owner and organization changes; a change that changes nothing writes no row. Ids only, no personal data, never trimmed; the tenant role may only read and insert, and triggers refuse UPDATE, DELETE and TRUNCATE. Owner-only paged read API with actor/action/target/date filters | api/src/domain/audit; api/src/infra/db/repositories/audit.repository.ts; api/src/observability/request-context.ts |
| Audit evidence (OCT-77): each organization's finished periods (a UTC day by default) are sealed on Sui by the worker — the confirmed ledger facts and audit log rows of the period, hashed into a manifest and sealed in the immutable `octap_audit::evidence_seal` package, chained to the previous seal and contiguous on-chain (empty periods are sealed too, so none can be skipped). An encrypted (Seal) copy of each bundle goes to a Walrus Console private folder. Owner-only read API (periods, detail, bundle download, recomputation for the Console's Verify button) and `@octap/verify`, which checks a bundle or a recomputation against the seal read straight from Sui | api/src/domain/audit; contracts/audit; ts-sdks/packages/verify; api/src/infra/clients/walrus |
| Tenant authorization: API-key auth (`Authorization: Bearer`), scopes, credential issue/revoke | api/src/infra/auth |
| Console API keys: an Owner or Business Developer issues (`read` by default; only the Owner issues a live `write` key, while a Business Developer may issue a sandbox one, OCT-297), renames and revokes the organization's keys from the Google session (a Business Developer only read keys), at most 25 ACTIVE per organization (409 `API_CREDENTIAL_LIMIT_REACHED`); `/v1/api-credentials` and rotation are removed (OCT-70). The `admin` scope is retired: no route requires it, and a console key works for every integration flow (OCT-301) | api/src/api/rest/console-api-credentials.controller.ts; api/src/domain/identity/console-api-credentials.service.ts; api/src/infra/auth/api-credentials.service.ts |
| Credits: reversal of a CONFIRMED earn (while its points are unspent, not held by a pending redemption, and more than 10 minutes from expiry) or redeem, idempotent, at most once | api/src/domain/credits/reversal.service.ts |
| Credits: reversals of chain-confirmed earns/POS redemptions mirrored on-chain (`reverse_earn`/`reverse_redeem`, at most once on-chain too), via the same outbox → worker → digest-first path as earn | contracts/sui/sources/credit_account.move; api/src/domain/credits/chain-submit.processor.ts (`processReversal`); `recordReversalTransaction` |
| Webhooks: Owner-only console endpoint registration, disable/enable, secret rotation, a test event to one endpoint (`webhook.test`, OCT-297) and dead-letter replay (an API key only lists endpoints and deliveries, OCT-301), signed delivery, retry/dead-letter, Node SDK verifier and typed events (`constructWebhookEvent`) | api/src/domain/webhooks; ts-sdks/packages/node/src/webhooks.ts |
| Webhooks: one transactional outbox for every event (OCT-325): `recordEvent(tx, ...)` writes an `organization_events` row in the transaction of the change, endpoint or not, and queues one delivery per ACTIVE endpoint, all under one event id. Exactly one `credits.earn.confirmed` / `credits.redemption.confirmed` per chain-confirmed transaction, whichever path confirmed it; `credits.earned` at accept; voucher lifecycle events (`voucher.created` / `submitted` / `returned` / `activated` / `publish.failed` / `paused` / `archived`). Events are kept 30 days, except those still owed or replayable (`EventRetentionWorker`) | api/src/infra/db/repositories/events.repository.ts; voucher-events.ts; api/src/domain/webhooks/README.md |
| Console event stream (OCT-326): `GET /v1/console/organizations/:id/events`, Server-Sent Events of the organization's events as thin hints (type and subject ids) for the console to refetch; Owner or Business Developer with the Google ID token as Bearer (a `fetch`-based client), `Last-Event-ID` resume or `stream.reset`, heartbeat with an access re-check, closes when the token expires; one scan of `organization_events` per HTTP instance per second, not Redis pub/sub | api/src/domain/events; api/src/api/rest/console-events.controller.ts; ts-sdks/packages/contracts/src/organization-events.ts |
| Authorization hardening: per-credential and per-IP public-route rate limiting, RLS enforced on every tenant-scoped read and write of the credits, rewards, webhooks and API-key repositories, including worker and indexer callbacks (OCT-289) | api/src/infra/auth; api/src/infra/cache; api/src/infra/db/rls.ts; api/src/infra/db/repositories/tenant-lookup.ts |
| System users: explicit SYSTEM_USER/SYSTEM_ADMIN platform roles, preserving legacy admin assignments through migration 0014 | api/src/infra/db/schema/auth.schema.ts; ts-sdks/packages/contracts/src/system-users.ts; docs/system-roles.md |
| Organizations: admin-attributed applications, paginated platform list/detail, safe slug resolution, durable worker-backed program provisioning/status | api/src/domain/organizations; api/src/api/rest/organizations.controller.ts |
| Administration: audited requests, ownership transfer, display-name approval, suspension/reinstatement/deactivation, terminal decisions and inactive-organization API-key enforcement | api/src/domain/administration; api/src/api/rest/administration.controller.ts |
| Organization details: Owners change display details (`name`, an https `logoUrl`) directly; legal details (legal name, tax ID, representative, CCCD, one-time type) change only through a System Admin-approved `UPDATE_IDENTITY` request, one pending per organization, stale approvals refused, the new CCCD held encrypted outside the request payload (OCT-281) | api/src/infra/db/organization-identity.rules.ts; api/src/infra/db/repositories/governance.repository.ts; docs/console-google-login.md |
| MCP sign-in: Core is the OAuth 2.1 authorization server for MCP hosts (dynamic client registration, authorization code with PKCE S256 behind the console Google sign-in, one-hour opaque tokens bound to user, organization and persona, revocation). `ConsoleAccessGuard` accepts these tokens for GET requests on the bound organization only, rechecking the membership each time; `octap-mcp serve-http` serves remote MCP over Streamable HTTP with the user's token (OCT-293). Each session sees the tools and prompts of its persona: Developers get member lookups and API keys, Owners get everything plus member vouchers and the refund policy, both get `get_connection` (OCT-294) | api/src/domain/mcp-auth; api/src/api/rest/mcp-oauth.controller.ts; ts-sdks/packages/mcp/src/http.ts; ts-sdks/packages/mcp/src/personas.ts |
| Dashboard assistant: `POST /v1/console/organizations/:organizationId/assistant/messages` streams (SSE) an answer from an OpenAI model (`OPENAI_MODEL`), which reads the organization through the MCP server with a 10-minute MCP token Core issues for the user's persona, revoked after the turn. 503 until the OpenAI key and model, `OCTAP_MCP_PUBLIC_URL` and MCP sign-in are set; limits on message and conversation length, 12 tool calls per turn, 10 messages per user per minute; nothing stored (OCT-308) | api/src/domain/assistant; api/src/infra/clients/openai; api/src/api/rest/console-assistant.controller.ts |
| Members: tenant customer search/detail, exact POS ID lookup, Owner-only profile/status edits and blocked-member command eligibility | api/src/domain/members; api/src/api/rest/members.controller.ts |
| Console: audited operator bootstrap/link script, direct Google identity verification, org/persona-protected profile/staff/credential reads, approved organization onboarding, Developer invitations and suspension/restoration, and System Admin first-Owner bootstrap for active ownerless organizations | api/src/domain/identity; api/src/api/rest/console*; docs/console-google-login.md |
| Identity: Google zkLogin via Enoki (address resolution, end-user binding, token-proven org enrollment, merchant `verifyCustomer` in the Node SDK), sponsored-transaction boundary for the future customer-signed redeem | api/src/domain/identity; api/src/infra/clients/enoki; api/src/infra/clients/sui/sui-transaction-builder.client.ts |
| Operations: durable-command acceptance with payload-hash conflict detection, reusable across features; UNKNOWN-state recovery for operations a crashed worker left stuck in PROCESSING | api/src/infra/db/repositories/operations.repository.ts (`acceptCommand`, `recoverStaleProcessing`) |
| Credits: real on-chain customer-signed POS redemption (reserve/finalize, sponsored, confirmed by reading the chain's own verdict) | api/src/domain/credits/pos-redemption.service.ts; api/src/api/rest/credits.controller.ts (`POST /v1/credits/redeem/reserve`, `POST /v1/credits/redeem/finalize`) |
| Credits: chain-time expiry buckets mirrored into Postgres (FIFO consumption, lazy expiry sweep, `CreditExpired` projection) | api/src/infra/db/repositories/credits.repository.ts (`expireDueBuckets`); api/src/domain/indexer |
| Indexer: `octap::credit_account` event projection with a committed cursor, reconciling PENDING/UNKNOWN earn and POS redeem from the chain; balance `asOfCheckpoint`/`observedAt`/`stale` | api/src/domain/indexer; api/src/infra/db/repositories/indexer.repository.ts |
| Operations: outcome-unknown chain submits (earn, POS finalize) resolved by a digest recorded before sending — confirmed, failed, or released once expired, never resent | api/src/domain/credits/chain-outcome.reconciler.ts; `OctapChainClient.sign`/`executeSigned`/`findTransaction` |
| Programs: per-organization on-chain program provisioning (create program, publish+activate policy, mint IssuerCap), worker-only | api/src/domain/programs; api/src/infra/clients/sui/program-admin.client.ts; scripts/provision-program.mjs |
| Programs: issuance budget. Owners propose top-ups and System Admins approve them through change requests, a worker executes them with `AdminCap`, sessions and API keys read the live remaining amount, an earn it cannot cover gets 422, and `budget.low` warns at 80% and 95% used | api/src/domain/credits/issuance-budget.service.ts; api/src/domain/organizations/budget-top-up.processor.ts; contracts/sui/sources/budget_shard.move |
| Programs: earn-rate change. Owners propose a new base `earnBps` (`UPDATE_EARN_RATE`) and System Admins approve it through change requests; a worker publishes and activates a new policy version with `AdminCap` (no new `IssuerCap`) and updates the program row in place (OCT-341) | api/src/domain/organizations/earn-rate-change.processor.ts; api/src/domain/programs/programs.service.ts (`rotateEarnRate`); contracts/sui/sources/program_control.move (`activate_policy`) |
| Voucher refunds: tenant-specific immutable policy versions and claim-time snapshots, Owner-only console publication recording the publishing user (`createdByUserId`; legacy key versions keep `createdByCredentialId`), history readable with a `read` key, atomic coupon/stock/refund decisions; the policy is the only gate on used/expired refunds by a `write` key (OCT-301) | api/src/domain/rewards/console-refund-policy.service.ts; api/src/domain/rewards/refund-policy.ts; api/src/domain/rewards/refund-policy.service.ts; api/src/infra/db/repositories/voucher-refund-policies.repository.ts; Node SDK |

### Known gaps in implemented features

- On-chain vouchers (OCT-279) are an alpha. Core still holds the issuer key for merchants, so a merchant's terms are published on its behalf; moving `AdminCap` to merchant owners and revoking caps are not started. A customer paying their own gas can call `claim_voucher` directly, which bypasses catalog stock and pausing, and which the indexer does not project; `credit_account::redeem` has the same gap. A customer's own-gas `use_voucher` landing after a refund leaves the voucher cancelled here and used on-chain, which only a log reports. The refund policy is published as part of the terms, and Core enforces it, not Move. The serial-only redeem route is gone, so the POC's redeem path needs OCT-228. Live Testnet verification through a real Enoki sponsorship is outstanding.
- Voucher refund policy settings have Owner-only console routes (OCT-301) but no frontend editor, approval queue or console staff roles yet. Refund windows measure elapsed time from claim, not appointment time; coupon reactivation/reissuance and expiry extensions remain unimplemented. Live Testnet verification of the configurable policy cases remains outstanding.

- The **indexer** only reconciles rows still PENDING. The chain-submit worker now marks a row
  FAILED only on a returned on-chain `failure`; an `earn()` call that throws (outcome unknown)
  stays PENDING with its operation UNKNOWN, so the indexer confirms it if it landed. If it never
  landed, `ChainOutcomeReconciler` (OCT-52) releases it once the chain is past the transaction's
  expiration epoch — for address-balance gas that is the SDK's `ValidDuring` window, so up to two
  epochs (~2 days on testnet) of a held, `stale` balance first. `stale` is "anything
  pending", not "indexer behind the chain tip". First run starts at the stream head, not genesis
  (see `api/src/domain/indexer/README.md`).

- **Earn** is chain-dispatched (worker, IssuerCap-signed) and **POS redemption** is now also
  chain-dispatched (customer-signed, Enoki-sponsored, see the row above). Paid voucher claims now reserve stock and points atomically, require a customer signature through the same sponsored redeem/finalize pipeline, and activate only after chain confirmation (OCT-231). Since OCT-279, the claim also records the voucher on-chain in the same transaction, and only the customer's signature can mark it used. The catalog and serials remain in PostgreSQL.

- POS redemption's reserve/finalize split has no equivalent of Harbor's `/resume` endpoint for a
  package-version cutover mid-reserve (not applicable yet — this repo has no published-package
  migration story at all) and no admin/grant revocation race handling (POS redemption grants
  nothing to revoke). Its Redis reserve cache TTL (600s) is a judgment call, not read from Enoki's
  own sponsor-digest lifetime (undocumented at integration time) — may need tuning once exercised
  against real Enoki responses, not just the mocked tests and the local-Postgres repository
  checks this shipped with.
- `PosRedemptionService.finalize()`'s Redis cache deletion happens after
  `confirmPosRedemptionOnChain` commits, not in the same transaction (harmless: the entry expires
  on its own). Its webhook is no longer emitted there: `credits.redemption.confirmed` is queued
  inside the confirm itself (OCT-209).
- Identity's login/enroll endpoints (and POS `redeem/finalize`) are intentionally public (`@Public()`, no `@Tenant()`/`@Scopes()`), limited per client IP
  (`PublicRateLimitGuard`; set `TRUSTED_PROXY_HOPS` behind a proxy, and a merchant server proxying these routes counts as one IP): the
  Google id_token is the proof of identity on login and enroll, and Enoki validates it, not this process. All merchants share one
  Google client ID, so a token captured by one merchant is valid at another's `POST /v1/identity/verify` and can enroll that customer there for its roughly one-hour lifetime; spending still needs the customer's signature (accepted until per-merchant clients, see OCT-196). Enroll no longer takes `externalMemberId`, because a value the caller chooses proves nothing; a merchant-side way to set it is not built. No customer
  session/bearer token is issued — balance and voucher reads still require the merchant API-key
  guard until a real customer-session mechanism is separately scoped. The ephemeral keypair for
  signing is entirely client-side (this process only ever sees its public half); nonce/proof
  endpoints are thin Enoki passthroughs with no local cryptography.
- Earn is dispatched against the calling organization's own provisioned program (OCT-73,
  `domain/programs`' `resolveProgramConfig`); there is no shared default program. An organization
  without an `ACTIVE`, sharded `programs` row gets HTTP 422 on earn and on POS redeem reserve
  (`credit_account::redeem` needs no program ids — the account records its own program). There
  is no dedicated `domain/organizations` provisioning surface; console applications and
  platform approval now create org rows. There is no standalone
  `domain/policies` versioning/preview API yet — policy publish/activate are steps inside
  `ProgramsService.provisionForOrganization`, not their own CRUD surface. Provisioning can't be
  exercised live without a real `SUI_PROGRAM_ADMIN_PRIVATE_KEY` (checked `.env`: absent) — proven
  instead by a new Move test, `credit_account_tests.move`'s
  `earn_rejects_issuer_cap_scoped_to_a_different_program`, plus unit tests with a mocked
  `ProgramAdminClient`.
- Worker signers are AWS KMS keys (OCT-245, `docs/kms-signer.md`): the issuer and program admin
  keys are two `ECC_NIST_EDWARDS25519` KMS keys, signed through Mysten's `@mysten/aws-kms-signer`
  with the AWS SDK's default credential chain, so no private key material sits in app memory, on
  disk, or in an env var. On testnet the existing raw keys were imported into KMS, so both
  addresses and every cap they hold stayed put; the dev team signs through one shared IAM user
  scoped to `kms:Sign` on the two keys, Harbor's service-account model. AWS was chosen over the GCP KMS that Harbor (`D:\CommandOSS\harbor`,
  `SuiKmsSignerService`) uses; its design carried over (scheme read from the key, public key
  cached, production refuses raw keys), its GCP client code didn't need to. The two keys stay
  separate, each with its own IAM role, so a hosted worker can't sign with the `AdminCap` key. A raw `SUI_*_PRIVATE_KEY` still works as a local fallback when no KMS key is
  set (contributors without AWS access), and is refused on mainnet. Still deferred: mainnet keys with a
  stricter key policy and the worker on AWS compute with no access keys at all; Harbor's
  single-omnibus-signer model with per-tenant authorization tracked in the DB; `IssuerCap`/
  `AdminCap` revocation (no `revoke`/`burn` in the Move contracts); spend-anomaly alerting on the
  shared signers. Live KMS latency is measured with `scripts/check-kms-signer.mjs` and recorded in
  `docs/kms-signer.md` (about 0.5 s per signature from Vietnam to `ap-southeast-2`).
- Re-provisioning an organization (OCT-244): a member's existing `CreditAccount` stays in the old
  program, so their next `earn` aborts with `EWrongProgram`. The chain-submit worker then reads
  the account's on-chain `program_id`, and only if it differs from the organization's current
  program does it open a new account in the current program, replace `sui_credit_account_id`
  with it and retry the earn once. If the account is already in the current program (the same abort code
  also covers an IssuerCap for the wrong program), nothing changes and the earn fails for a human
  to look at. What is still not handled: the credits in the old account stay there on-chain, in
  the old program. Postgres `confirmedBalance` still counts them, but a POS redeem only sees the
  new account's on-chain balance, and a reversal of an earn made in the old program targets the
  new account and aborts. Moving balances between programs needs its own design.
- Fixed (OCT-55): the worker used to open every `CreditAccount` under a placeholder address
  derived from the PG ownership row id, nobody's private key — written before Identity existed
  and never updated, which would have permanently blocked POS redemption (`beneficiary` is set
  once at `open_account` and `credit_account.move` has no entry point to change it). Now looks up
  `end_users.suiAddress` via `CreditsRepository.findBeneficiaryAddress`, always populated by earn
  time since `organization_end_users` can only exist after a prior Google login.
- `operation_key` anti-replay and the issuance budget are enforced on-chain by
  `operation_shard`/`budget_shard` (OCT-41), with shard ids taken from the organization's
  `programs` row. Every program runs `shard_count = 1` today; see `contracts/sui/README.md`'s
  known gaps.
- `acceptCommand`'s payload-hash conflict only guards against this process accepting two
  different payloads under one key — `EarnService` already short-circuits on a repeated
  idempotency key earlier (at the `loyaltyTransactions` level), so in practice this conflict
  path isn't reachable through today's one real caller; it exists for the next caller that
  doesn't have its own equivalent check. A conflict also isn't mapped to a clean HTTP 409 yet —
  it surfaces as an uncaught error, since no caller can trigger it through the HTTP layer today.
- `recoverStaleProcessing` flips a stuck operation to UNKNOWN at worker startup, and
  `ChainOutcomeReconciler` then settles it by its recorded digest (OCT-52) — it never resubmits.
  It relies on the digest being recorded *before* sending, so an UNKNOWN earn with no digest is
  treated as never sent and released: an UNKNOWN row left over from before OCT-52 (when nothing
  recorded a digest first) would be released the same way, so check for
  `status = 'UNKNOWN' and sui_tx_digest is null` before deploying onto an existing database.
  A POS finalize digest whose sponsored bytes carry no expiration can't be proven never-landed
  and is logged for a human; while it is unresolved, `/reserve` refuses to sponsor fresh bytes
  for that hold (409) so it can't turn into a second on-chain redeem. A reserve that is never
  finalized at all is released lazily (OCT-244): the member's next reserve or balance read marks
  any of their holds that are past `ABANDONED_POS_HOLD_GRACE_MS` (30 min) and still have no
  finalize digest FAILED, and returns those points to the available balance. Until that member
  reserves or reads their balance again, the stale hold still shows in `pendingRedemption`; unsigned voucher claims also have a worker sweep; submitted digests are never released by age alone.
- `claimNextPending` is one conditional `UPDATE` per candidate row (documented in its own doc
  comment), not a batched `SKIP LOCKED` claim — fine for today's single worker only.
- Webhook endpoint `secret` is stored as plaintext, not via a secrets manager/KMS: a known,
  deliberate gap.
- The console event stream (OCT-326) only carries what `organization_events` records: vouchers,
  credits and the issuance budget. Members, API keys and webhook endpoints record no events yet, so
  those screens don't update from it. Recording one there (`recordEvent` plus its subject in
  `api/src/domain/events/event-subjects.ts`) streams it with no other change; whether merchants also
  get them as webhooks is undecided. The 5-streams-per-user limit is per HTTP instance. An open
  stream misses an event whose transaction stays open more than 60 s between recording it and
  committing; a reconnect still replays it.
- **Reversing a spent earn is not supported** (OCT-334). An EARN can be reversed only while its
  bucket is whole, not held by a pending redemption, and more than 10 minutes from expiry (the
  chain checks expiry again when the worker submits), the same rule as the chain's `reverse_earn`. Otherwise the call is
  a 409, and the merchant compensates outside the ledger. There is no clawback debt: Postgres used
  to let the balance go negative while the chain refused the reversal, which left the two ledgers
  apart for good. Follow-up if refunds after spending are needed: a clawback on-chain
  (`reverse_earn` takes what remains of the bucket and records the rest as a debt that later earns
  repay and that blocks redemption), mirrored in Postgres. Reversing a REDEEM adds the points back
  without a bucket, matching the chain's `non_expiring` balance. Paid voucher claims use the same on-chain reversal pipeline, keyed by `voucher-claim-<ownershipId>`. Historical Postgres-only claims still have no chain receipt.
- **Expiry** (OCT-49) is lazy: due buckets are swept whenever the balance is read or spent, not
  by a scheduled job. Every balance check (POS reserve, voucher claim) and `GET /balance` sweeps
  first; only the informational `newBalance` in earn/POS-finalize responses can show a
  pre-sweep figure until the next read. Uses the server clock, not the Sui `Clock` (the two agree to
  within seconds). The forfeit is capped at the current balance, so expiry never creates debt.
  Earns confirmed before migration `0008` have no bucket until the indexer replays their
  `CreditEarned`: set the `octap::credit_account` row's `cursor` to null once after migrating.
- No mTLS: deliberately not built at the app layer — there is no reverse proxy/Dockerfile in
  this repo yet to terminate TLS in front of it, and raw `https.Server` client-cert verification
  inside the Node process would be guessing at a deployment shape that doesn't exist. mTLS
  belongs at a proxy (nginx/Envoy/load balancer) forwarding a verified-identity header, when one
  gets introduced.
- No request signing: HMAC signing was removed in OCT-70 (no route used it, and its key was the
  stored `keyHash`, so it added no secret). This leaves machine-to-machine API-key traffic (a
  merchant backend calling Core directly) with no request signing or replay protection. MCP
  sign-in (OCT-293) does not cover it: its tokens are console-session-bound and GET-only, and
  `MCP_OAUTH_SIGNING_KEY` only signs dynamic client registrations. The planned fix goes in the
  `@octap/sdk` transport layer, not per route, so every SDK caller, including the stdio MCP
  client, signs requests without its own logic. Key management through the SDK or MCP, if it
  comes back, needs a new design: an Ed25519 keypair held by the client and a scope ceiling.
- Creating a voucher takes no `idempotencyKey`: a create whose response is lost gets a 409 on retry,
  and the caller finds it with `listVouchers`. A later fix belongs in rewards: an `idempotencyKey`,
  or the same `code` and content returning the existing voucher.  Voucher lifecycle webhooks
  (OCT-325) cover create, submit, return, activate, publish failure, pause and archive; running out of
  supply (`DEPLETED`) and expiry send none.
- Console API keys record no creator or revoker, and survive the member who issued them leaving:
  an Owner revokes them by hand. There is no rotation and no expiry from the console.
- System-user (dashboard login) sessions are a separate, not-yet-started auth path from the
  API-key model entirely.
- RLS (`withTenant()`/`withRls()`, real `authenticated`/`service_role` roles and grants — see
  `docker/postgres-init`) covers every tenant-scoped method of `CreditsRepository`,
  `RewardsRepository`, `WebhooksRepository` and `ApiCredentialsRepository` (OCT-289), with a policy
  on `credit_ownerships`, `voucher_ownerships` and `credit_buckets` that resolves the organization
  through the member. Eight methods stay on the plain pooled connection, by design, each marked
  `RLS exception` in the code: `ApiCredentialsRepository.findByKeyHash` (finds the organization),
  `WebhooksRepository.claimDueDeliveries`' scan (every organization's due deliveries; each claim
  then runs under its organization), `CreditsRepository.findMemberOrganizationId` (finds the
  organization), `findCreditOwnershipBySuiAccountId` (the indexer only has the chain account) and
  `hasAnyLoyaltyTransactions` (environment-wide), and `OrganizationEventsRepository`'s
  `latestSequence` and `scanSince` (the console stream's scan over the organizations with a stream
  open on the instance; each event then goes only to its own organization's streams) and
  `deleteExpired` (trims every organization's events). Request paths pass the authenticated
  organization, so RLS refuses another organization's row. Only worker and indexer callbacks,
  which start from an id, first read that row's organization (`tenantOf` in `tenant-lookup.ts`);
  the console and POS finalize steps share two of them (`confirmPosRedemptionOnChain`,
  `confirmVoucherUse` and their `fail…`), keyed by a digest cached at the authenticated reserve. Checks on `organizations` and `end_users`,
  which the tenant role cannot read, run as the connection's own role (`asOwnRole`).
  `recordEarnTransaction` still accepts its command before entering `withActiveMember`, as before.
  Other repositories (identity, members, programs, operations, organizations…) are not converted.

## Not started

Suggested location follows the existing pattern: `api/src/domain/<feature>` for services and
module, `api/src/api/rest/<feature>.controller.ts` for HTTP, `api/src/infra/...` for persistence
and vendor clients.

### API domains

| Feature | Suggested location | Notes |
| --- | --- | --- |
| Identity: system-user (dashboard login) sessions | domain/identity | Separate from the Google zkLogin flow implemented above; merchant/admin dashboard login, not the end-user customer identity |
| Authorization hardening: mTLS | api/src/infra/auth | Basic API-key/scope/tenant guard is implemented; see Known gaps above |
| Wildcard subdomain hosting | domain/organizations / Web hosting | Path-based /orgs/:slug fallback and safe Core slug resolution implemented; DNS/host routing remains deployment work |
| Members: enrollment, identity binding | domain/members | Schema exists in members.schema.ts |
| Policies: standalone versioning and preview API | domain/policies | Publish/activate exist today only as steps inside `domain/programs`' provisioning flow, not their own CRUD/preview surface |
| Campaigns: draft, preview, approval | domain/campaigns | Executes only an approved immutable manifest |
| Billing: Stripe test billing, reconciliation | domain/billing; infra/clients/stripe | Schema exists in billing.schema.ts; distinct from points |
| Analytics: derived analytics export | domain/analytics; infra/clients/clickhouse; api/db/clickhouse | Analytics-only store |
| Notifications | domain/notifications | |


### Workers

Each worker lives next to its feature as `<job>.worker.ts` (consumer lifecycle) and
`<job>.processor.ts` (one job through domain services), registered only in `api/src/worker.module.ts`.
A queue adapter goes in `infra/queue` when the first worker needs one.

| Job | Feature |
| --- | --- |
| Transaction submission to Sui (earn only — see known gaps) | credits (implemented: chain-submit.worker.ts) |
| Projection from chain to PostgreSQL | operations |
| Webhook delivery | webhooks |
| Analytics export | analytics |
| Billing reconciliation | billing |
| Notification delivery | notifications |

### Cross-cutting API

| Feature | Suggested location |
| --- | --- |
| Request validation pipes, error filters, interceptors | api/src/common or api/src/api |
| Redis cache and realtime push | infra/cache; infra/realtime |
| gRPC transport (server and Node SDK) | api/src/api/grpc; ts-sdks/packages/node/src/transports |
| Protobuf contracts | ts-sdks/packages/contracts |

### Sui Move contracts (contracts/sui/sources)

Object map from the design: `capabilities`, `program_control`, `policy_version`, `credit_account`
`budget_shard`, `operation_shard` (**implemented**, see Implemented above and
`contracts/sui/README.md`), `operation_receipt`, `campaign_authorization` (not
started).
Add each remaining module with its tests under `contracts/sui/tests`.

### SDKs

| Feature | Package |
| --- | --- |
| Offline earn-intent buffering | browser |
| Webhook signature verification | node |
| Deadlines and retries | node |

Organization slug entry is implemented behind ORG_SLUG_ENTRY_ENABLED (default false) and is not operational yet; it does not configure wildcard DNS.
