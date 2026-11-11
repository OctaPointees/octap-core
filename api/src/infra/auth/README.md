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
  `signed-request.decorator.ts`'s `@RequireSignedRequest()` is opt-in per route. **No route
  requires a signed request today**: the only one that did, `/v1/api-credentials`, was removed in
  OCT-70. The decorator and the guard's unit tests stay for the next route that needs it.
- `api-credentials.service.ts` / `api-credentials.repository.ts`: issue, rename, revoke, each taking
  an optional `tx` so the console's access check commits with the write.
  The raw key is returned exactly once, on issue; only its SHA-256 hash is persisted. An
  organization holds at most 25 ACTIVE keys, script-issued ones included: the count and the insert
  run under a `FOR UPDATE` lock on the organization row, and the 26th gets a 409 with
  `code: "API_CREDENTIAL_LIMIT_REACHED"`. `api-credentials.module.ts` provides the service without
  the global guard, for the console (`IdentityModule`).
- `public.decorator.ts`: `@Public()` opts a route or controller out of the guard entirely. Only
  for customer-device endpoints whose caller never holds a merchant credential and where
  something else proves authorization: `IdentityController` (Google id_token, validated by Enoki)
  and `POST /v1/credits/redeem/finalize` (the customer's zkLogin signature over the sponsored
  digest). A public route has no `request.tenant`.
- `public-rate-limit.guard.ts`: the per-client-IP limit on those two public surfaces, applied with
  `@UseGuards` because `ApiKeyGuard` returns before its own limiter on a public route. Answers 429,
  and fails closed like the credential limiter. An IPv6 client is counted per /64. `request.ip` is
  the direct peer unless `TRUSTED_PROXY_HOPS` says how many proxies to trust, so a client cannot
  forge a new address with `X-Forwarded-For`.
- `scopes.decorator.ts`, `tenant.decorator.ts`, `tenant-context.ts`: route-level plumbing.

Not implemented yet: mTLS (deliberately — see `docs/roadmap.md` for why) and system-user
(dashboard login) sessions.
