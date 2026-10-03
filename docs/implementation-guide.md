# Team implementation guide

## Start with the owning feature

Each domain folder holds its use-case services and module. Core flows have dedicated service
files so new work does not accumulate in a generic service. Read that domain's README before
adding code. Introduce DTO/type/port methods when their contract is reviewed; do not create one
class per field or force a service/repository/worker onto features that do not need it.

| Work item | Primary files/folders |
| --- | --- |
| Login, sessions, zkLogin | api/src/domain/identity; api/src/infra/clients/enoki |
| Tenant, role, scope and object rules | api/src/domain/authorization; api/src/api/guards |
| Organizations and subdomains | api/src/domain/organizations |
| Enrollment and member identity binding | api/src/domain/members |
| Program controls/capabilities | api/src/domain/programs; contracts/sui |
| Policy versions and preview | api/src/domain/policies/policies.service.ts; policy-preview.service.ts |
| Earn | api/src/domain/credits/earn.service.ts |
| Customer-signed redemption | api/src/domain/credits/redemption.service.ts |
| Cancellation and reversal | api/src/domain/credits/reversal.service.ts |
| Expiry/clawback | api/src/domain/credits/expiry.service.ts |
| Command/idempotency/outbox | api/src/domain/operations/operations.service.ts; outbox.service.ts |
| UNKNOWN operation recovery | api/src/domain/operations/operation-recovery.service.ts |
| Campaign draft/preview/approval | api/src/domain/campaigns; campaign-approval.service.ts |
| Reward catalog and voucher lifecycle | api/src/domain/rewards |
| API keys/scopes/sandbox/logs | api/src/domain/developer |
| Merchant webhooks | api/src/domain/webhooks; infra/clients/merchant-webhooks |
| Stripe test billing | api/src/domain/billing; infra/clients/stripe |
| Audit/export/verifier | api/src/domain/audit; audit-verifier.service.ts; infra/clients/walrus and seal |
| Checkpoint cursor/replay | api/src/domain/indexer; infra/db/repositories/indexer-cursors.repository.ts |
| Derived analytics | api/src/domain/analytics; infra/clients/clickhouse |
| Notifications | api/src/domain/notifications |
| Platform governance | api/src/domain/administration |

## API transport, domain and persistence

1. Define a reviewed public request/response in ts-sdks/packages/contracts; keep Node/browser wire behavior compatible.
2. Map and validate requests in api/src/api/dto and rest controllers or grpc adapters.
3. Implement shared identity/tenant/scope/object authorization before exposing endpoints.
4. Implement use-case orchestration in the owning domain service. Controllers own protocol details.
5. Define required domain ports near the feature; common integration slots exist in domain/shared/integration.ports.ts.
6. Implement DB access in infra/db/repositories and vendor calls in infra/clients. Bind implementations in Nest modules.
7. Add migrations under api/db and meaningful tests under api/tests. A conceptual ERD is not a ready SQL schema.

For earn, the intended path is a credits controller -> earn service -> operations/outbox acceptance
-> transaction processor -> Sui/Enoki clients -> checkpoint/projection processing -> operation status.
Those are destinations for future implementation; no step currently executes. Durable command
acceptance must precede dispatch, and only successful chain effects establish confirmed points.

## Workers belong to their feature

| Job | Location |
| --- | --- |
| Transaction submission | domain/credits/transaction.worker.ts and transaction.processor.ts |
| Bucket expiry | domain/credits/expiry.worker.ts and expiry.processor.ts |
| Projection | domain/operations/projection.worker.ts and projection.processor.ts |
| Checkpoint ingestion/replay | domain/indexer/checkpoint.worker.ts and checkpoint.processor.ts |
| Signed delivery | domain/webhooks/webhook.worker.ts and webhook.processor.ts |
| Analytics export | domain/analytics/analytics.worker.ts and analytics.processor.ts |
| Audit export | domain/audit/audit.worker.ts and audit.processor.ts |
| Billing reconciliation | domain/billing/billing.worker.ts and billing.processor.ts |
| Notification delivery | domain/notifications/notifications.worker.ts and notifications.processor.ts |

Paths in this table are relative to api/src. A worker owns consumer lifecycle/concurrency/shutdown;
a processor coordinates a job through domain services. Neither duplicates rules from HTTP handlers.
Register runtime providers in worker.module.ts, not app.module.ts. Queue plumbing belongs in
infra/queue. Job schemas, retries, schedules and consumers remain unimplemented.

## Frontend and SDKs

Pages/layouts under frontend/src/app compose surfaces. Put product UI in components/<feature>,
queries/mutations and view state in hooks/<feature>, transport mapping in lib/octap-api, and
session/tenant/query composition in providers. Keep auth, config and monitoring in their named
lib folders. Server-enforced permissions remain necessary even when layouts are separate.

Node client and REST/gRPC transports belong in ts-sdks/packages/node. Customer signing/login
and provisional offline snapshots belong in packages/browser. Shared DTOs belong in
packages/contracts. Merchant private credentials never enter browser SDK options.

## Contract and test boundaries

Sui object modules stay under contracts/sui/sources; add layouts/functions only with reviewed
invariants and tests under contracts/sui/tests. Deploy/codegen tooling goes in contracts/sui/scripts.
API tests are grouped by unit, integration and contract. Frontend tests use unit, integration and
e2e slots. SDK tests cover actual transport/error/signature behavior when it exists. No placeholder
coverage target or mock integration result is claimed by this scaffold.

The existing lint/build/typecheck/bootstrap commands validate structure. Add runtime dependencies,
feature-specific tests and integration checks with implementation rather than preloading every
library or copying Harbor-specific tooling into this repository.
