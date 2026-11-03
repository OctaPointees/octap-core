# Organization management and provisioning (OCT-36)

System Admin Google-authenticated platform routes:

- GET `/v1/platform/organizations`: cursor pagination (`limit` 1–100, default 25),
  status and literal name/slug search (`q`). Returns safe organization/program state
  and the latest provisioning operation; no private CCCD, signer keys or capabilities.
- GET `/v1/platform/organizations/:id`: same safe detail and provisioning state.
- GET `/v1/platform/owner-candidates?q=...`: up to 25 existing Google-bound users,
  searched by name/email (2–160 characters). Returns ID/name/email only.
- POST `/v1/platform/organizations`: existing onboarding input plus `ownerUserId`.
  Creates a PENDING_APPROVAL application, attributed to the admin, with the chosen
  initial Owner recorded separately. Approval uses OCT-208/OCT-39's existing atomic
  workflow; it grants Owner to that user, not implicitly to the requesting admin.
- POST `/v1/platform/organizations/:id/provision`: accepts a durable worker command
  for an ACTIVE organization. Body: `earnBps` (0–10000), `expiryDays` (1–3650),
  `totalBudget` (positive safe integer), `shardCount` (1–16), and `idempotencyKey`
  (8–128 letters/digits/period/underscore/colon/hyphen). Other fields are rejected.
  Same key/config replays the command; conflicting payload returns 409. A pending,
  processing or unknown command, or any existing program reservation, blocks a new one.

Self-service applications and Owner profile updates continue using existing console
routes. Organization status, display-name review, transfer and deactivation are governed
by OCT-208 requests; there is no second direct status-mutation path.

## Worker boundary and outcomes

The HTTP module never imports ProgramsService, signers, the processor or worker.
Run a configured worker with `ORG_PROVISION_WORKER_ENABLED=true`; the default is false
so a normal issuer-only worker does not claim program-admin jobs. Set
`ORG_PROVISION_POLL_INTERVAL_MS` (default 3000) and the existing program-admin signer,
Sui network/package and issuer-public-key settings. The worker role needs program-admin
signing authorization and access to resolve the issuer's public address; private keys
and AWS credentials stay off Web/HTTP. See docs/kms-signer.md for signer setup.

State: PENDING -> PROCESSING -> SUBMITTED (program ACTIVE). Pre-chain prerequisite
failure becomes FAILED and can be submitted again under a new key. Once chain calls
are attempted, any failure becomes UNKNOWN, including lost persistence after success.
Stale PROCESSING jobs older than 30 minutes become UNKNOWN. UNKNOWN is never claimed
or automatically resubmitted, and blocks replacement commands for that organization.

The existing provisioning adapter performs multiple chain stages. A transport error
may leave partial on-chain effects even if its program reservation was released.
Inspect operation/program state and Sui transactions as an operator before repairing
the record; do not clear UNKNOWN and mint again blindly. There is no automatic
multi-stage chain reconciliation or force-retry endpoint in this delivery. Errors
shown by the platform are sanitized; provider errors cannot expose credentials.

Admin list/detail shows program and operation state; Web polls in-flight detail and
supports manual status refresh. Live Testnet provisioning requires funded configured
signers. Integration tests persist real program/operation rows but fake the chain boundary;
they do not claim a live Testnet run or change a shared database.

## Tenant resolution

Public GET `/v1/organizations/resolve/:slug` returns only active organization
ID/name/slug. Pending/suspended/archived tenants return 404. Business Web uses
`/orgs/:slug` as the ticket's path-based fallback; sign-in preserves that destination,
then requires an explicit current membership before entering the dashboard. Resolving
a slug does not grant any role, and protected Core routes still verify tenant access.
No Host/X-Forwarded-Host tenant trust or wildcard DNS provisioning is introduced.

Slug entry is implemented but not operational by default. ORG_SLUG_ENTRY_ENABLED must explicitly equal true to expose the public resolver; otherwise it returns 404. Coordinate with Web's VITE_ENABLE_ORG_SLUG_ENTRY. No DNS configuration is performed.
