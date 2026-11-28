# Events domain: the console event stream (OCT-326)

`GET /v1/console/organizations/:organizationId/events` is a Server-Sent Events stream of what
happens to an organization. The console uses it to refetch a screen when something on it changes,
instead of reloading or polling. Its only source is the outbox, `organization_events` (OCT-325,
see the webhooks README). Anything recorded there with `recordEvent` reaches the stream.

## What a client gets

- **Who:** an active Owner or Business Developer of an active organization, with the Google ID
  token as `Authorization: Bearer`. Anyone else gets a JSON 403 before the stream starts. An MCP
  token is refused: it answers one request at a time.
- **Client:** a `fetch`-based SSE reader (e.g. `@microsoft/fetch-event-source`), because the
  browser's `EventSource` cannot send an `Authorization` header. Tokens never go in the URL.
- **Messages:** thin, so access to the data stays with the REST routes' checks. SSE `id` is the
  event's `sequence`, SSE `event` is its type, and `data` is an `OrganizationStreamEvent`
  (`@octap/contracts`): `{ id, sequence, type, subject, occurredAt }`. `subject` says what changed:
  a `voucher` (with its `batchId`), a `voucherOwnership`, a `loyaltyTransaction` or the
  `issuanceBudget`. The client refetches it.
- **Resuming:** send `Last-Event-ID` (the last `id` seen) to get what was missed, then new events.
  `stream.reset` instead means that point is gone (older than 30 days, or unknown) or more than
  1000 events back: refetch everything, then carry on.
- **Closing:** `stream.token_expired` when the token the stream was opened with expires (reconnect
  with a fresh one and `Last-Event-ID`). `stream.access_revoked` when the caller stops being an
  active Owner or Business Developer (checked again at every heartbeat; don't reconnect).
- **Heartbeat:** a `: ping` comment every 20 s (`CONSOLE_EVENTS_HEARTBEAT_MS`), so proxies don't
  close an idle connection. `retry: 3000` is sent once, when the stream opens.
- **Limit:** 5 streams per user per instance (429 beyond).
- A message can repeat, or come from just before the stream connected. It is only a hint to
  refetch, so that is harmless. Dedupe on `id` if a screen cares.

## How it works

- `OrganizationEventHub` (one per HTTP instance): while a stream is open, one loop scans
  `organization_events` for the organizations with streams open, every second
  (`CONSOLE_EVENTS_POLL_INTERVAL_MS`), and hands each new event to that organization's streams.
  It is one query per instance, however many streams are open. Only committed rows are read, so a
  stream never announces a change that rolled back. Events written by the worker process (chain
  confirmations) arrive the same way.
- `sequence` is assigned at insert, not at commit, so an event can become visible after a higher
  one. Each scan therefore reads again from the highest sequence seen at least 60 s ago
  (`LATE_COMMIT_WINDOW_MS`) and skips what it already sent. A transaction that stays open longer
  than that between recording an event and committing would have the event missed by open streams
  (a reconnect still replays it).
- `ConsoleEventStreamService`: the checks before the stream starts, then replay
  (`Last-Event-ID`), live events, heartbeat with the access check, and the token expiry.
- `EventRetentionWorker` (worker process): every hour, deletes events older than 30 days, except
  those an endpoint is still owed (PENDING delivery) or that may still be replayed (DEAD_LETTER).

### Why not Redis pub/sub or `LISTEN/NOTIFY`

- **Redis pub/sub** cannot be part of the transaction that records the event. Publishing inside
  it can announce a change before it commits (the client refetches old data, then hears nothing
  more). Publishing after the commit means changing every caller, and still loses the message if
  the process dies in between. Pub/sub keeps no history, so a reconnect would read the table
  anyway. The shared Redis client is fail-fast (it stops reconnecting), and Redis is disposable
  (`docs/architecture.md`). It could later be added as a "scan now" nudge, with the table still
  the source.
- **`LISTEN/NOTIFY`** fires on commit, which fits. But Core reaches Postgres through the Supabase
  transaction pooler, which does not support `LISTEN`.

## Not covered yet

Members, API keys and webhook endpoints record no events, so their screens don't update from the
stream. Once they record one (`recordEvent`, plus a subject in `event-subjects.ts`, which the
compiler asks for), it streams with no change here. Whether merchants should also get those as
webhooks is a separate decision.
