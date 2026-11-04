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
| System users: explicit SYSTEM_USER/SYSTEM_ADMIN platform roles, preserving legacy admin assignments through migration 0014 | api/src/infra/db/schema/auth.schema.ts; ts-sdks/packages/contracts/src/system-users.ts; docs/system-roles.md |
| Administration: audited requests, ownership transfer, display-name approval, suspension/reinstatement/deactivation, terminal decisions and inactive-organization API-key enforcement | api/src/domain/administration; api/src/api/rest/administration.controller.ts |
| Members: tenant customer search/detail, exact POS ID lookup, Owner-only profile/status edits and blocked-member command eligibility | api/src/domain/members; api/src/api/rest/members.controller.ts |
| Console: audited operator bootstrap/link script, direct Google identity verification, org/persona-protected profile/staff/credential reads, approved organization onboarding, Developer invitations and suspension/restoration, and System Admin first-Owner bootstrap for active ownerless organizations | api/src/domain/identity; api/src/api/rest/console*; docs/console-google-login.md |
| Identity: Google zkLogin via Enoki (address resolution, end-user binding, org enrollment), sponsored-transaction boundary for the future customer-signed redeem | api/src/domain/identity; api/src/infra/clients/enoki; api/src/infra/clients/sui/sui-transaction-builder.client.ts |
| Operations: durable-command acceptance with payload-hash conflict detection, reusable across features; UNKNOWN-state recovery for operations a crashed worker left stuck in PROCESSING | api/src/infra/db/repositories/operations.repository.ts (`acceptCommand`, `recoverStaleProcessing`) |
| Credits: real on-chain customer-signed POS redemption (reserve/finalize, sponsored, confirmed by reading the chain's own verdict) | api/src/domain/credits/pos-redemption.service.ts; api/src/api/rest/credits.controller.ts (`POST /v1/credits/redeem/reserve`, `POST /v1/credits/redeem/finalize`) |
| Credits: chain-time expiry buckets mirrored into Postgres (FIFO consumption, lazy expiry sweep, `CreditExpired` projection) | api/src/infra/db/repositories/credits.repository.ts (`expireDueBuckets`); api/src/domain/indexer |
| Indexer: `octap::credit_account` event projection with a committed cursor, reconciling PENDING/UNKNOWN earn and POS redeem from the chain; balance `asOfCheckpoint`/`observedAt`/`stale` | api/src/domain/indexer; api/src/infra/db/repositories/indexer.repository.ts |
| Operations: outcome-unknown chain submits (earn, POS finalize) resolved by a digest recorded before sending — confirmed, failed, or released once expired, never resent | api/src/domain/credits/chain-outcome.reconciler.ts; `OctapChainClient.sign`/`executeSigned`/`findTransaction` |
| Programs: per-organization on-chain program provisioning (create program, publish+activate policy, mint IssuerCap), worker-only | api/src/domain/programs; api/src/infra/clients/sui/program-admin.client.ts; scripts/provision-program.mjs |
| Programs: budget top-up for a drained issuance budget (`budget_shard::top_up`, AdminCap-gated), worker-only | contracts/sui/sources/budget_shard.move; api/src/domain/programs/programs.service.ts (`topUpBudget`); scripts/top-up-budget.mjs |
| Voucher refunds: tenant-specific immutable policy versions and claim-time snapshots, audited admin publication/history, atomic coupon/stock/refund decisions; policy-enabled used/expired refunds additionally require admin authorization | api/src/domain/rewards/refund-policy.ts; api/src/domain/rewards/refund-policy.service.ts; api/src/infra/db/repositories/voucher-refund-policies.repository.ts; Node SDK |

### Known gaps in implemented features

- Voucher refund policy settings have no frontend editor, approval queue or console staff roles yet. Use server-side admin API credentials. Refund windows measure elapsed time from claim, not appointment time; coupon reactivation/reissuance and expiry extensions remain unimplemented. Live Testnet verification of the configurable policy cases remains outstanding.

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
  path, `RedemptionService`/`POST /v1/credits/redeem`, remains a legacy Postgres-only API. Paid voucher claims now reserve stock and points atomically, require a customer signature through the same sponsored redeem/finalize pipeline, and activate only after chain confirmation (OCT-231). Coupon catalog and serial records remain in PostgreSQL.

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
- `emit()` (the accept-time `credits.earned` and the legacy PostgreSQL-only `credits.redeemed`) is not in
  the same DB transaction as the write that triggers it (a crash in between, or a failed enqueue
  that `emit()` only logs, silently drops the event). The chain-confirmation events and, since
  OCT-244, `credits.reversed` and `voucher.redeemed` already use the outbox form,
  `enqueueWebhookEvent(tx, ...)`; these two could move to it too. The endpoint
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
  nothing retries it. Paid voucher claims use the same on-chain reversal pipeline, keyed by `voucher-claim-<ownershipId>`. Historical Postgres-only claims still have no chain receipt.
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
| Organizations and subdomains | domain/organizations | Console creation/approval and profile setup implemented; wildcard DNS and full lifecycle remain |
| Members: enrollment, identity binding | domain/members | Schema exists in members.schema.ts |
| Policies: standalone versioning and preview API | domain/policies | Publish/activate exist today only as steps inside `domain/programs`' provisioning flow, not their own CRUD/preview surface |
| Campaigns: draft, preview, approval | domain/campaigns | Executes only an approved immutable manifest |
| Developer: API keys, scopes, sandbox, request logs | domain/developer | |
| Billing: Stripe test billing, reconciliation | domain/billing; infra/clients/stripe | Schema exists in billing.schema.ts; distinct from points |
| Analytics: derived analytics export | domain/analytics; infra/clients/clickhouse; api/db/clickhouse | Analytics-only store |
| Audit: export, Walrus/Seal evidence, verifier | domain/audit; infra/clients/walrus, seal | Outside checkout path |
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
