# Developer

The server side of the developer hub (OCT-46). Today: the request log (OCT-298). Sandbox mode
(OCT-297) lands here next.

## Request log

What a merchant's developers need to debug their integration without OctaP's server logs, modelled
on Stripe Workbench (logs, grouped errors, `stripe logs tail`) and on the RED method (rate, errors,
duration). Field names follow the OpenTelemetry HTTP semantic conventions: `route` is
`http.route` (the template, so calls to one endpoint group together), `statusCode` is
`http.response.status_code`, `latencyMs` is `http.server.request.duration` in milliseconds.

**Recording** (`request-log.middleware.ts`, applied to every route by `DeveloperModule`). When the
response finishes, one `api_request_logs` row is written for a call that `ApiKeyGuard` resolved to a
key: method, route, path (without its query, and with only UUID parameters filled in, so free text
never lands in the log), status, latency, category (`request-log-category.ts`),
the correlation id (OCT-60, the `X-Request-Id` header), the user agent, and, for a non-2xx response,
its error `code`, `message` and body (capped at 8 KB). A 2xx body is never stored.
Calls that fail before a key is resolved (no key, unknown or revoked key) are not recorded: they
have no organization. A call refused after the key is known (missing scope, rate limit) is.
Best effort, like `lastUsedAt`: a failed write is logged, never retried, never surfaced.

**RLS.** The tenant role may only `SELECT` and `INSERT` rows: a merchant cannot edit or delete its
history. The retention sweep deletes as the connection's own role.

**Tests** drain in-flight writes (`drainRequestLogWrites`) before truncating the database: a write
landing during the truncate deadlocks with it.

**Not an audit trail.** Rows are deleted after 30 days (`request-log-retention.worker.ts`, worker
only, hourly, in batches) and a write may be dropped. Who changed what is in `organization_events`.

**Reading** (`request-logs.service.ts`, `GET /v1/console/organizations/:organizationId/request-logs…`,
Owner or Business Developer of an ACTIVE organization, under RLS). Every read takes the same
filters: `from`/`to` (ISO 8601, default the last 24 hours, at most 30 days), `credentialId`,
`category`, `method`, `status` (`succeeded`, `failed`, `4xx`, `404`, …) and `route`.

| Route | For |
| --- | --- |
| `GET …/request-logs?page&limit` | The list, newest first, with a total for the pager. |
| `GET …/request-logs/:requestId` | One call, with a failed call's full error body: what a merchant quotes to support. |
| `GET …/request-logs/tail?cursor` | Live tail: poll with the returned cursor. The first call (no cursor) starts now. Rows are read in writing-transaction order and only below the snapshot's `xmin`, so a row that committed late is returned later, never skipped. A long transaction elsewhere delays the tail. |
| `GET …/request-logs/summary` | Totals plus the same per category, per endpoint (top 20) and per key: requests, succeeded, client and server errors, error rate, p50/p95/p99 latency. |
| `GET …/request-logs/timeseries?interval` | Buckets for the traffic chart, empty ones included. `interval` is `1m`, `5m`, `15m`, `1h` or `1d`; left out, the finest one with at most 120 buckets. Buckets start exactly at `from`, so pass a local midnight for local days. |
| `GET …/request-logs/errors` | Failed calls grouped by endpoint, status and error code, most frequent first, with first/last seen and the latest request id. |

Persistence is `infra/db/repositories/request-logs.repository.ts`.
