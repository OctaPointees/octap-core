# Architecture and source traceability

## Inputs

- [Solution architecture](https://github.com/OctaPointees/OctaP-Designing/blob/main/brainstorming/outputs/03-solution-architecture.md): NestJS modular monolith, independent worker processes, source-of-truth rules and Sui objects.
- [Product scope](https://github.com/OctaPointees/OctaP-Designing/blob/main/brainstorming/outputs/02-product-and-scope.md): SDK/identity/approval boundaries and non-transferable points.
- [Conceptual ERD](https://github.com/OctaPointees/OctaP-Designing/blob/main/reports/report-1/erd/report-explanation.md) and [use-case model](https://github.com/OctaPointees/OctaP-Designing/blob/main/reports/report-1/usecase.drawio.xml): entity vocabulary and functional boundaries, not a physical schema.
- Report 3 remains a continuously edited template, not a scaffold baseline.
- Team direction: OctaP_Core owns contracts, api, ts-sdks and the MCP adapter; OctaP_Web owns frontend; workers stay inside API. MCP lives in its own `ts-sdks/packages/mcp` (`@octap/mcp`) package and process within OctaP_Core.

## What was borrowed from Harbor

The local reference D:/CommandOSS/harbor has a single API package with separate server/worker
entrypoints. Its src/api folder owns transport, src/domain owns feature services and colocated
workers/processors, src/infra owns DB/cache/vendor/queue adapters, and src/observability owns
shared telemetry. Frontend has app, components, hooks, lib, providers and types; SDKs use packages.

OctaP adopts that file organization while retaining NestJS modules and dependency injection.
It does not copy Harbor's Hono/Effect runtime, wallet custody, queue library, business rules or integrations.

## Component map

The design components (identity, authorization, programs, policies, credits, operations, campaigns,
rewards, developer, webhooks, billing, analytics, audit, notifications, administration, indexer,
workers, Sui objects and SDK helpers) and where each one will live are tracked in
[the roadmap](roadmap.md). Only components listed there as implemented exist in the source tree.

## Dependencies and processes

HTTP transport -> domain/application services -> domain ports -> infrastructure adapters.
Workers -> processors -> the same domain/application services and ports.
OctaP_Web hooks -> typed API client -> public API; Node/browser SDKs -> public contracts.
Web consumes versioned public types/SDKs and has its own package manifest, lockfile, build and CI.
Core owns business and chain rules; Web owns presentation and interaction state.
Domain code never imports controllers or vendor SDKs. Infrastructure owns vendor details.

HTTP and worker share one build/package but run as separate processes. AppModule does not
import WorkerModule. WorkerModule alone registers worker/processor providers.

The MCP adapter lives in `ts-sdks/packages/mcp` (`@octap/mcp`) and runs as a separate stdio process from the
NestJS API and workers. Its initial read-only pilot calls Core through the authorized API/SDK
boundary; it must not copy business logic, bypass tenant/role/scope/object checks, query the database
directly, or implement its own point authority. Keep its dependencies, configuration and startup
command isolated from the API package. The pilot is for local/staging use, not production access.

## Sources of truth and deferred work

Sui is authoritative for confirmed points, policy enforcement and receipts. PostgreSQL owns
commands, idempotency, outbox and approvals; projections remain read replicas. Redis is disposable.
ClickHouse is analytics-only; Stripe test billing is distinct from loyalty points. Enoki credentials
stay backend-only. Customer redemption requires beneficiary consent; campaign execution requires
an approved immutable manifest. Walrus/Seal audit export stays outside checkout.

Credits and rewards currently persist to PostgreSQL only. The chain-side invariants above are
enforced once the Sui contracts, transaction worker and projection are built (see the roadmap).
