# Auth

Server-to-server authentication and tenant resolution for the REST API.

- `api-key.guard.ts`: registered as the global `APP_GUARD`. Validates `Authorization: Bearer
  <api key>` against `api_credentials`, resolves `request.tenant` strictly from the matched
  credential (a client-supplied `x-organization-id` is only ever checked, never trusted), and
  enforces any `@Scopes(...)` on the route.
- `api-credentials.service.ts` / `api-credentials.repository.ts`: issue, list, revoke, rotate.
  The raw key is returned exactly once, on issue/rotate; only its SHA-256 hash is persisted.
- `scopes.decorator.ts`, `tenant.decorator.ts`, `tenant-context.ts`: route-level plumbing.

Not implemented yet: mTLS, HMAC request signing, replay/nonce windows, rate limiting, and
system-user (dashboard login) sessions — see `docs/roadmap.md`.
