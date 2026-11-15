# observability

HTTP-process observability (OCT-60). Nothing here signs or reaches a worker-only module.

## Correlation id

`CorrelationIdMiddleware` (applied to every route by `ObservabilityModule`, so it runs before any
guard) gives each request one server-generated UUID:

- `request.correlationId`, read with `correlationIdOf(request)`, for anything that persists or
  forwards it (for example a merchant-facing request log);
- the `X-Request-Id` response header, exposed through CORS so a browser caller can read it;
- one access log line when the response finishes: `GET /v1/credits/budget 200 12ms requestId=<id>`,
  without the query string, at error level for a 5xx.

A client-sent `X-Request-Id` is ignored, so the id is always unique and always ours.

## Health

| Route | Auth | Shows |
| --- | --- | --- |
| `GET /health` | none | `status` plus each probe's `up`/`down` and latency. Cached 5s, one probe in flight. |
| `GET /v1/platform/health` | console session, platform admin | The same probes with their error text, plus `workerLag`. Never cached. |

Each probe (database `select 1`, Redis `PING`, Sui RPC latest checkpoint) times out after 3s.
`status` is `down` (and `/health` answers 503) when the database or Redis is unreachable, because
no authenticated route works without them. It is `degraded` (still 200) when only the Sui RPC is
unreachable: reads and accepted commands keep working and chain work waits in the outbox, and a
load balancer should not pull every instance over a flaky public RPC.

`workerLag` is read from what the workers leave in the database, so it still grows, and is still
visible, when no worker is running:

- `operations`: unsettled commands (PENDING, PROCESSING, UNKNOWN) per command type and status, with
  the age of the oldest. Customer-signed commands (POS redeem, voucher claim and use) sit PENDING
  until the customer signs: those groups are marked `awaitingCustomer` and left out of
  `oldestWorkerOwedAgeSeconds`, the headline figure to alert on, so one abandoned signature does not
  dominate it. Once UNKNOWN they are the reconciler's and count again.
- `webhookDeliveries`: pending, due now, the oldest due delivery's wait past its `nextAttemptAt`
  (one backing off until later is not lag), and dead-lettered.
- `indexer`: each stream's checkpoints, how far its furthest-known position trails the chain
  checkpoint from this report's Sui probe, and the time since the indexer last wrote its cursor row.
