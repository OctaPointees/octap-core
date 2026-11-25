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
  script), the actor is `SYSTEM`. Services pass nothing down.
- **Outbox events.** `recordEvent` audits every event recorded inside an authenticated request,
  as `action = <event type>` with the event id: `credits.earned`, `credits.reversed`,
  `voucher.*`. Events from workers and the chain (confirmations, `budget.low`) are not audited:
  nobody did them. The ledger already records them.
- **Explicit rows:**
  - `api_key.issued` / `renamed` / `revoked`
  - `webhook_endpoint.registered` / `enabled` / `disabled` / `secret_rotated`
  - `webhook_delivery.replayed`
  - `member.blocked` / `unblocked` / `updated`
  - `staff.suspended` / `restored`
  - `invitation.created` / `revoked` / `accepted`
  - `organization.profile_updated` / `settings_updated`
  - `refund_policy.published` (target: the version number)

  Governed changes keep their own trail in `organization_change_requests`.

## Storage

- **Durable and append-only.** Nothing trims it. The tenant role may only `SELECT` and
  `INSERT`, and a trigger refuses `UPDATE` and `DELETE` for every role.
- **No personal data.** Rows hold ids, field names and non-personal values only. Names and
  emails stay in their source tables. The read API resolves an actor's label at read time.
- **Shape.** Actor / action / target, as in WorkOS, Pangea and OCSF API Activity. `sequence`
  orders the log, and a future signed export (OCT-77) can digest it in batches.

## Reading

`GET /v1/console/organizations/:organizationId/audit-log`, Owner only. Newest first, cursor-paged,
filterable by `from`/`to`, `actorType`, `actorId`, `action` (exact, or a prefix ending in `.`),
`targetType` and `targetId`.
