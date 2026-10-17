# Auth

Server-to-server authentication and tenant resolution for the REST API.

- `api-key.guard.ts`: registered as the global `APP_GUARD`. Validates `Authorization: Bearer
  <api key>` against `api_credentials`, resolves `request.tenant` strictly from the matched
  credential (a client-supplied `x-organization-id` is only ever checked, never trusted),
  enforces any `@Scopes(...)` on the route, applies a per-credential rate limit (always), and —
  on routes marked `@RequireSignedRequest()` — verifies HMAC request signing with replay
  protection. Both the rate limiter and the replay check fail closed (reject) if Redis is
  unreachable; they never silently let a request through unprotected.
- `request-signing.util.ts` / `nonce-store.util.ts` / `rate-limit.util.ts`: the pure logic the
  guard calls. The HMAC signing key is the credential's already-stored `keyHash` — a client
  derives the same value locally by hashing the raw key it already holds, so no separate
  signing secret needs to be issued or stored. Canonical request = method + path + timestamp +
  nonce + sha256(raw body); `main.ts`'s `{ rawBody: true }` is what makes the real request
  bytes available to hash, instead of a re-serialized `JSON.stringify(request.body)`.
  `signed-request.decorator.ts`'s `@RequireSignedRequest()` is opt-in per route (applied today
  to `ApiCredentialsController`'s mutating routes) — existing clients that only send
  `Authorization: Bearer` aren't broken by it.
- `api-credentials.service.ts` / `api-credentials.repository.ts`: issue, list, revoke, rotate.
  The raw key is returned exactly once, on issue/rotate; only its SHA-256 hash is persisted.
- `scopes.decorator.ts`, `tenant.decorator.ts`, `tenant-context.ts`: route-level plumbing.

Not implemented yet: mTLS (deliberately — see `docs/roadmap.md` for why) and system-user
(dashboard login) sessions.
