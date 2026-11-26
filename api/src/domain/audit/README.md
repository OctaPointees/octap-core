# Audit

Three audit layers: the audit log (OCT-333, below), ledger verification (OCT-328/334, in
`domain/credits`) and sealed evidence (OCT-77, [Evidence](#evidence)).

## Writing

- **Where.** `recordAudit(tx, …)` (`infra/db/repositories/audit.repository.ts`) writes one
  `audit_log` row on the caller's transaction, so a change and its row commit together or not at
  all.
- **Who.** The actor comes from the request context (`observability/request-context.ts`).
  `CorrelationIdMiddleware` opens a context per HTTP request. `ApiKeyGuard` sets a `CREDENTIAL`
  actor, and `ConsoleAccessGuard` sets a `USER`. With no request (a worker, the indexer, a
  script), the actor is `SYSTEM`. Services pass nothing down. Background work started from inside
  a request (the console stream's poll timer, an API key's `lastUsedAt` write) runs through
  `outsideRequestContext`, so it never acts as that request's caller.
- **Outbox events.** `recordEvent` audits every event recorded inside an authenticated request,
  as `action = <event type>` with the event id: `credits.earned`, `credits.reversed`,
  `voucher.*`. Events from workers and the chain (confirmations, `budget.low`) are not audited:
  nobody did them. The ledger already records them.
- **Explicit rows:**
  - `api_key.issued` / `renamed` / `revoked`
  - `webhook_endpoint.registered` (the URL's origin only: a path often carries a token) /
    `enabled` / `disabled` / `secret_rotated` / `tested` (the test ping, OCT-297)
  - `webhook_delivery.replayed`
  - `member.blocked` / `unblocked` (only from BLOCKED) / `updated`
  - `voucher.updated` (field names only; a status change is its own `voucher.*` event)
  - `staff.suspended` / `restored`
  - `invitation.created` / `revoked` (also each pending invitation a suspension revokes) / `accepted`
  - `organization.profile_updated` / `settings_updated` / `owner_assigned` (a System Admin's
    first Owner)
  - `refund_policy.published` (target: the version number)

  A change that changes nothing (disabling a disabled endpoint, suspending a suspended member)
  writes no row. Governed changes keep their own trail in `organization_change_requests`.

## Storage

- **Durable and append-only.** Nothing trims it. The tenant role is granted only `SELECT` and
  `INSERT` (`scripts/migrate.mjs` revokes the rest after its blanket grant). Triggers refuse
  `UPDATE`, `DELETE` and `TRUNCATE` for every role, the owner included. Only the integration
  tests' `resetDb` switches the TRUNCATE trigger off, inside its own transaction.
- **No personal data.** Rows hold ids, field names and non-personal values only. Names and
  emails stay in their source tables. The read API resolves an actor's label at read time.
- **Shape.** Actor / action / target, as in WorkOS, Pangea and OCSF API Activity. `sequence`
  orders the log, and a future signed export (OCT-77) can digest it in batches. It is shared by
  every organization, so it never leaves the server: the read API pages by row id.

## Reading

`GET /v1/console/organizations/:organizationId/audit-log`, Owner only. Newest first, cursor-paged,
filterable by `from`/`to` (ISO 8601 with an offset or `Z`), `actorType`, `actorId`, `action`
(exact, or a prefix ending in `.`), `targetType` and `targetId`.

## Evidence

Sealed evidence (OCT-77). It answers an auditor's question: *is this period's data still what it
was when the period ended?* Sui already proves the on-chain ledger. What it cannot prove alone is
the off-chain record: who did what (the audit log above), receipts, purchase amounts, and which
receipt went with which chain transaction. Sealing makes any later change to them detectable.

- **Periods.** One per organization per period with activity: a UTC day (`EVIDENCE_PERIOD_MS`,
  five minutes for a demo). A period with no activity has no row. The worker
  (`evidence-seal.processor.ts`, on when `EVIDENCE_SEAL_ENABLED=true`) seals a period
  `EVIDENCE_SEAL_DELAY_MS` after it ends (10 minutes), which leaves room for writes still committing
  at the boundary. Nobody creates, edits or deletes a period by hand.
- **What a period holds.** Its `ledger`: loyalty transactions whose Sui transaction was confirmed
  in the period, with fields that never change once confirmed (no status: a reversal is its own fact,
  in its own period). Its `audit`: the audit log rows written in it. Never sandbox data (separate
  tables), the outbox (trimmed after 30 days) or the request log (kept 30 days).
  `EvidenceRepository.ledgerFacts` and `auditFacts` are the one definition of both.
- **Manifest.** Each section is hashed (sha256 of one canonical JSON line per fact), and the
  manifest (organization, period, both sections, the previous period's manifest hash) is hashed
  again. `@octap/verify` (`ts-sdks/packages/verify`) does the hashing, so Core, the Console and an
  auditor compute the same value.
- **Seal.** `octap_audit::evidence_seal::seal` (`contracts/audit`), signed by the issuer key, which
  holds the package's `SealerCap`. A seal is frozen and stamped by the chain's clock. The package's
  registry refuses a seal that does not follow the organization's latest one, so a sealed period can't
  be resealed, replaced or have another inserted before it. The package is immutable. A seal that
  may have landed on an interrupted try is looked up on-chain before it is sent again.
- **Copy on Walrus.** When `WALRUS_CONSOLE_API_KEY` and `WALRUS_CONSOLE_BUCKET_ID` are set, each sealed
  bundle is Seal-encrypted and uploaded to a Walrus Console private folder
  (`infra/clients/walrus`). Sealing never waits on it. Create the folder in Console first, then
  mint the `read_write` key and sign its access grant: a key is granted the private folders that
  exist when it is minted. The Console network (`WALRUS_CONSOLE_NETWORK`, mainnet by
  default) is independent of `SUI_NETWORK`: the copy is only stored there.
- **Reading** (Owner only, like the audit log), under
  `/v1/console/organizations/:organizationId/evidence`:
  - `GET /`: the periods, newest first, with `sealedThrough` and `periodCount`.
  - `GET /:periodId`: its hashes, its seal (network, package, object, transaction) and its copy.
  - `GET /:periodId/bundle`: the file for an auditor, the manifest as sealed plus the period's
    facts as the database holds them now. `npx @octap/verify <file>` checks it against Sui.
  - `GET /:periodId/verification`: for the Console's Verify button, the manifest as sealed and the
    period recomputed now. The browser checks both against the seal read straight from Sui
    (`verifyRecomputation`), so the verdict never rests on OctaP's word.

A Postgres reset that keeps an organization's id while the chain keeps its seals would leave that
organization unable to seal (its first new seal names no previous one). Testnet data is disposable:
republish `contracts/audit` after such a reset.
