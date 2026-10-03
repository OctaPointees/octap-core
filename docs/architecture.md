# Architecture and source traceability

## Inputs

- [Solution architecture](https://github.com/OctaPointees/OctaP-Designing/blob/main/brainstorming/outputs/03-solution-architecture.md): NestJS modular monolith, independent worker processes, source-of-truth rules and Sui objects.
- [Product scope](https://github.com/OctaPointees/OctaP-Designing/blob/main/brainstorming/outputs/02-product-and-scope.md): SDK/identity/approval boundaries and non-transferable points.
- [Conceptual ERD](https://github.com/OctaPointees/OctaP-Designing/blob/main/reports/report-1/erd/report-explanation.md) and [use-case model](https://github.com/OctaPointees/OctaP-Designing/blob/main/reports/report-1/usecase.drawio.xml): entity vocabulary and functional boundaries, not a physical schema.
- Report 3 remains a continuously edited template, not a scaffold baseline.
- Team direction: four product roots (contracts, api, frontend, ts-sdks), workers inside API, MCP in a separate repo.

## What was borrowed from Harbor

The local reference D:/CommandOSS/harbor has a single API package with separate server/worker
entrypoints. Its src/api folder owns transport, src/domain owns feature services and colocated
workers/processors, src/infra owns DB/cache/vendor/queue adapters, and src/observability owns
shared telemetry. Frontend has app, components, hooks, lib, providers and types; SDKs use packages.

OctaP adopts that file organization while retaining NestJS modules and dependency injection.
It does not copy Harbor's Hono/Effect runtime, wallet custody, queue library, business rules or integrations.

## Component map

| Design | Scaffold location |
| --- | --- |
| NestJS REST/Node gRPC | api/src/api/rest and api/src/api/grpc |
| Shared application services | api/src/domain/<feature> and DomainModule |
| Identity/tenant/scope/approval | identity and authorization domains; api/guards |
| Program/policy/member/credit | programs, policies, members and credits domains |
| Durable command/idempotency/outbox/recovery | operations domain; infra/db/repositories; db/postgres |
| Transaction/expiry workers | credits domain; worker.module.ts |
| Projection/recovery workers | operations domain; worker.module.ts |
| Checkpoint ingestion/replay | indexer domain; infra/clients/sui |
| Google zkLogin/sponsorship | identity/zklogin.service.ts; infra/clients/enoki |
| Signed merchant webhooks | webhooks domain; infra/clients/merchant-webhooks; Node SDK helpers |
| ClickHouse analytics | analytics domain; infra/clients/clickhouse; db/clickhouse |
| Audit/Walrus/Seal | audit domain; infra/clients/walrus and seal |
| Stripe merchant billing | billing domain; infra/clients/stripe |
| Redis/realtime | infra/cache and infra/realtime |
| Logs/metrics/lag | api/src/observability |
| Sui object map | contracts/sui/sources |
| Public API types/OpenAPI/protobuf | ts-sdks/packages/contracts |
| Merchant Node SDK | ts-sdks/packages/node |
| Browser login/signing/offline helpers | ts-sdks/packages/browser |
| Merchant/admin/customer/POS surfaces | frontend/src/app and feature components/hooks |
| MCP | Separate repository; consume authenticated API/SDK boundaries |

## Dependencies and processes

HTTP transport -> domain/application services -> domain ports -> infrastructure adapters.
Workers -> processors -> the same domain/application services and ports.
Frontend hooks -> typed API client -> public API; Node/browser SDKs -> public contracts.
Domain code never imports controllers or vendor SDKs. Infrastructure owns vendor details.

HTTP and worker share one build/package but run as separate processes. AppModule does not
import WorkerModule. WorkerModule alone registers worker/processor providers. No consumers,
timers or job execution exist in the scaffold.

MCP has no package, dependencies, startup script or server code in this repo. A future separate
MCP adapter calls the same authorized API use cases through an API/SDK boundary; it must not
copy business logic, bypass tenant/role/scope/object checks, or implement its own point authority.
No separate MCP repo is created by this scaffold change.

## Sources of truth and deferred work

Sui is authoritative for confirmed points, policy enforcement and receipts. PostgreSQL owns
commands, idempotency, outbox and approvals; projections remain read replicas. Redis is disposable.
ClickHouse is analytics-only; Stripe test billing is distinct from loyalty points. Enoki credentials
stay backend-only. Customer redemption requires beneficiary consent; campaign execution requires
an approved immutable manifest. Walrus/Seal audit export stays outside checkout.

None of those invariants is enforced by empty classes. DTO schemas, domain rules, port methods,
physical tables/RLS, endpoint/RPC methods, retries, signers, worker execution, protocol conformance,
Move object layouts/entry functions, external connections and product UI remain unimplemented.
The scaffold reserves distinct files/folders and composes modules; it does not report mocks as integrations.
