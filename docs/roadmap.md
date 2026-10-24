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
| Test layer: Vitest unit specs per domain/infra/SDK + integration specs against real Postgres/Redis (testcontainers), coverage-gated in CI | api/tests; ts-sdks/packages/*/tests; vitest.config.ts |
| Sui Move: capabilities, program_control, policy_version, credit_account (earn/redeem, expiry-bucket FIFO) | contracts/sui/sources; tests under contracts/sui/tests |
| Move-generated TS bindings (`@mysten/codegen`) + chain client | ts-sdks/packages/chain |
| Earn lands on Sui: durable PG command → outbox → worker dispatch → on-chain confirmation | api/src/domain/credits/chain-submit.worker.ts, chain-submit.processor.ts; api/src/infra/clients/sui |
| CORS enabled (permissive) so a separately-hosted frontend can call the API | api/src/main.ts |
| Tenant authorization: API-key auth (`Authorization: Bearer`), scopes, credential issue/revoke/rotate | api/src/infra/auth; api/src/api/rest/api-credentials.controller.ts |
| Credits: reversal of a CONFIRMED earn or redeem, idempotent, at most once, with clawback debt | api/src/domain/credits/reversal.service.ts |
| Credits: reversals of chain-confirmed earns/POS redemptions mirrored on-chain (`reverse_earn`/`reverse_redeem`, at most once on-chain too), via the same outbox → worker → digest-first path as earn | contracts/sui/sources/credit_account.move; api/src/domain/credits/chain-submit.processor.ts (`processReversal`); `recordReversalTransaction` |
| Webhooks: endpoint registration, signed delivery, retry/dead-letter/replay, Node SDK verifier and typed events (`constructWebhookEvent`) | api/src/domain/webhooks; ts-sdks/packages/node/src/webhooks.ts |
| Webhooks: exactly one `credits.earn.confirmed` / `credits.redemption.confirmed` per chain-confirmed transaction, queued in the same DB transaction as the confirm (outbox), whichever path confirmed it | api/src/infra/db/repositories/credits.repository.ts (`confirm*OnChain`); `enqueueWebhookEvent` in webhooks.repository.ts |
| Authorization hardening: per-credential rate limiting, opt-in HMAC request signing with replay/nonce protection, RLS actually enforced on the earn/redeem/reversal write path | api/src/infra/auth; api/src/infra/cache; api/src/infra/db/repositories/credits.repository.ts |
| Identity: Google zkLogin via Enoki (address resolution, end-user binding, org enrollment), sponsored-transaction boundary for the future customer-signed redeem | api/src/domain/identity; api/src/infra/clients/enoki; api/src/infra/clients/sui/sui-transaction-builder.client.ts |
| Operations: durable-command acceptance with payload-hash conflict detection, reusable across features; UNKNOWN-state recovery for operations a crashed worker left stuck in PROCESSING | api/src/infra/db/repositories/operations.repository.ts (`acceptCommand`, `recoverStaleProcessing`) |
| Credits: real on-chain customer-signed POS redemption (reserve/finalize, sponsored, confirmed by reading the chain's own verdict) | api/src/domain/credits/pos-redemption.service.ts; api/src/api/rest/credits.controller.ts (`POST /v1/credits/redeem/reserve`, `POST /v1/credits/redeem/finalize`) |
| Credits: chain-time expiry buckets mirrored into Postgres (FIFO consumption, lazy expiry sweep, `CreditExpired` projection) | api/src/infra/db/repositories/credits.repository.ts (`expireDueBuckets`); api/src/domain/indexer |
| Indexer: `octap::credit_account` event projection with a committed cursor, reconciling PENDING/UNKNOWN earn and POS redeem from the chain; balance `asOfCheckpoint`/`observedAt`/`stale` | api/src/domain/indexer; api/src/infra/db/repositories/indexer.repository.ts |
| Operations: outcome-unknown chain submits (earn, POS finalize) resolved by a digest recorded before sending — confirmed, failed, or released once expired, never resent | api/src/domain/credits/chain-outcome.reconciler.ts; `OctapChainClient.sign`/`executeSigned`/`findTransaction` |
| Programs: per-organization on-chain program provisioning (create program, publish+activate policy, mint IssuerCap), worker-only | api/src/domain/programs; api/src/infra/clients/sui/program-admin.client.ts; scripts/provision-program.mjs |
| Programs: budget top-up for a drained issuance budget (`budget_shard::top_up`, AdminCap-gated), worker-only | contracts/sui/sources/budget_shard.move; api/src/domain/programs/programs.service.ts (`topUpBudget`); scripts/top-up-budget.mjs |

### Known gaps in implemented features

- The **indexer** only reconciles rows still PENDING. The chain-submit worker now marks a row
  FAILED only on a returned on-chain `failure`; an `earn()` call that throws (outcome unknown)
  stays PENDING with its operation UNKNOWN, so the indexer confirms it if it landed. If it never
  landed, `ChainOutcomeReconciler` (OCT-52) releases it once the chain is past the transaction's
  expiration epoch — for address-balance gas that is the SDK's `ValidDuring` window, so up to two
  epochs (~2 days on testnet) of a held, `stale` balance first. `stale` is "anything
  pending", not "indexer behind the chain tip". First run starts at the stream head, not genesis
  (see `api/src/domain/indexer/README.md`).

- **Earn** is chain-dispatched (worker, IssuerCap-signed) and **POS redemption** is now also
  chain-dispatched (customer-signed, Enoki-sponsored, see the row above) — but the *other* redeem
  path, `RedemptionService`/`POST /v1/credits/redeem` (used for voucher claims — an internal
  points-ledger debit, not a cash-out), is deliberately still Postgres-only and untouched: a
  voucher claim was never meant to need the member's own signature, so there is nothing to wire
  there. `credit_account::redeem` requires the beneficiary's own signature (Move-enforced, not a
  bug) — a worker signing with the IssuerCap key would abort on-chain every time, which is why POS
  redemption needed its own reserve/finalize flow instead of reusing the earn worker's pattern.
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
  inside the confirm itself (OCT-209), and POS redemptions no longer send `credits.redeemed`.
- Identity's login/enroll endpoints (and POS `redeem/finalize`) are intentionally public (`@Public()`, no `@Tenant()`/`@Scopes()`): the
  Google id_token is the proof of identity, and Enoki validates it, not this process. No customer
  session/bearer token is issued — balance and voucher reads still require the merchant API-key
  guard until a real customer-session mechanism is separately scoped. The ephemeral keypair for
  signing is entirely client-side (this process only ever sees its public half); nonce/proof
  endpoints are thin Enoki passthroughs with no local cryptography.
- Earn is dispatched against the calling organization's own provisioned program (OCT-73,
  `domain/programs`' `resolveProgramConfig`); there is no shared default program. An organization
  without an `ACTIVE`, sharded `programs` row gets HTTP 422 on earn and on POS redeem reserve
  (`credit_account::redeem` needs no program ids — the account records its own program). There
  is also no `domain/organizations` (org rows are inserted out of band) or standalone
  `domain/policies` versioning/preview API yet — policy publish/activate are steps inside
  `ProgramsService.provisionForOrganization`, not their own CRUD surface. Provisioning can't be
  exercised live without a real `SUI_PROGRAM_ADMIN_PRIVATE_KEY` (checked `.env`: absent) — proven
  instead by a new Move test, `credit_account_tests.move`'s
  `earn_rejects_issuer_cap_scoped_to_a_different_program`, plus unit tests with a mocked
  `ProgramAdminClient`.
- `SUI_PROGRAM_ADMIN_PRIVATE_KEY` is a second raw private key sitting in `.env`, alongside
  `SUI_ISSUER_PRIVATE_KEY` — adequate on testnet, but not how a comparable Sui backend we have
  local access to (Walrus Console / Harbor, `D:\CommandOSS\harbor`) handles this at all: its
  `SuiKmsSignerService` (`api/src/infra/clients/sui-kms-signer.client.ts`) holds **zero** raw
  private keys. The actual signer lives in Google Cloud KMS; the app only holds a key reference
  (`KMS_KEY_OMNIBUS_SIGNER`) and calls KMS's `asymmetricSign` RPC — the private key material
  never exists in app memory, on disk, or in an env var, and production refuses to boot without
  KMS configured (`config/env.ts`'s `"FATAL: production requires KMS"` guard). It also uses a
  single omnibus signer rather than one raw key per capability type: per-tenant scoping is done
  at the application/DB layer (`active-signers.repository.ts` tracks a `serviceSignerAddress`
  per API key; granting access adds that address to an on-chain permissioned-group/ACL) instead
  of minting a separate capability object under a separate backend-held key per tenant. Adopting
  this here (a KMS-backed signer, one key instead of two, authorization via DB-tracked grants)
  is real follow-up work, intentionally not done in this PR — it needs real cloud KMS
  infrastructure this project doesn't have set up yet, which is a bigger decision than this
  ticket's scope.
- A `CreditAccount` is scoped to the program it was opened in, but `credit_ownerships` stores only
  its id, not which program. If an organization is ever re-provisioned, its members' existing
  accounts belong to the old program and `earn` aborts on-chain (`EWrongProgram`) until their
  `sui_credit_account_id` is cleared so the worker reopens them under the new program.
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
  finalized at all still holds its points indefinitely — no hold-expiry policy yet.
- `claimNextPending` is one conditional `UPDATE` per candidate row (documented in its own doc
  comment), not a batched `SKIP LOCKED` claim — fine for today's single worker only.
- Webhook delivery is only wired into `EarnService`/`RedemptionService`; `ReversalService` and
  `RewardsService` don't call `WebhookDeliveryService.emit()` yet — same one-line pattern, not
  done here to keep this change reviewable. `emit()` (the accept-time `credits.earned` and the
  voucher `credits.redeemed`) is also not in the same DB transaction as the write that triggers it
  (a crash in between would silently drop the event) — the chain-confirmation events already use
  the outbox form, `enqueueWebhookEvent(tx, ...)`, and these two could move to it too. The endpoint
  `secret` is stored as plaintext, not via a secrets manager/KMS — both are known, deliberate gaps,
  not oversights; the first needs the OCT-43 outbox generalized to cover this too.
- Reversal's "clawback debt" is just letting `confirmedBalance` go negative, which already blocks
  further redemption via the existing balance check — there is no separate debt ledger, repayment
  plan, or collections flow. Reversing an EARN empties that earn's expiry bucket so it can't be
  forfeited again; reversing a REDEEM adds the points back *without* a bucket, so they never
  expire in Postgres. The chain mirrors both (OCT-50): a reversed REDEEM's add-back is a
  non-expiring on-chain balance too. Reversing an earn whose credits were already spent (or have
  expired) is accepted in Postgres but aborts on-chain (`EBucketUnavailable`), so that account's
  two balances differ until a human settles it; the mirror command is FAILED with the abort and
  nothing retries it. A voucher-claim REDEEM never reached the chain, so its reversal has no
  mirror.
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
| Policies: standalone versioning and preview API | domain/policies | Publish/activate exist today only as steps inside `domain/programs`' provisioning flow, not their own CRUD/preview surface |
| Campaigns: draft, preview, approval | domain/campaigns | Executes only an approved immutable manifest |
| Developer: API keys, scopes, sandbox, request logs | domain/developer | |
| Billing: Stripe test billing, reconciliation | domain/billing; infra/clients/stripe | Schema exists in billing.schema.ts; distinct from points |
| Analytics: derived analytics export | domain/analytics; infra/clients/clickhouse; api/db/clickhouse | Analytics-only store |
| Audit: export, Walrus/Seal evidence, verifier | domain/audit; infra/clients/walrus, seal | Outside checkout path |
| Notifications | domain/notifications | |
| Administration: platform governance | domain/administration | |

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
`budget_shard`, `operation_shard` (**implemented**, see Implemented above and
`contracts/sui/README.md`), `operation_receipt`, `campaign_authorization`, `audit_manifest` (not
started).
Add each remaining module with its tests under `contracts/sui/tests`.

### SDKs

| Feature | Package |
| --- | --- |
| Customer login (zkLogin) helper | browser — `loginWithGoogle()`/`enroll()` call the new identity endpoints, but obtaining the Google id_token itself (sign-in popup/button) is OctaP_Web's job, not this SDK's |
| Customer transaction signing | browser |
| Offline earn-intent buffering | browser |
| Webhook signature verification | node |
| Deadlines and retries | node |
