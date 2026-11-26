# Audit

The organization's audit log (OCT-333): who did what, and when. This is the first of three audit
layers. Ledger verification is OCT-328/334. A signed export is OCT-77.

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
