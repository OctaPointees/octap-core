# OctaP Source
Project scaffold based on the [OctaP design knowledge base](https://github.com/OctaPointees/OctaP-Designing).

## Product directories

```text
contracts/                 Sui Move package and contract tooling slots
api/                       NestJS API and background workers in one package
  src/
    main.ts                HTTP entrypoint
    worker.ts              Worker entrypoint
    api/                   REST, gRPC, DTOs, guards and interceptors
    domain/                Feature services, domain rules, workers and processors
    infra/                 Repositories, cache, vendor clients, queue and realtime
    config/                Startup configuration slots
    observability/         Shared logging, tracing and metrics slots
  db/                      PostgreSQL and ClickHouse migration slots
  scripts/                 Operational tooling slots
  tests/                   Unit, integration and contract test locations
frontend/                  Next.js merchant/admin portal and customer/POS reference
  src/app/                 Route and layout boundaries
  src/components/          UI organized by feature, shared components and primitives
  src/hooks/               Feature query/state hooks
  src/lib/                 API access, auth, config, monitoring and pure helpers
  src/providers/           Session/tenant/query provider composition
  src/types/               Shared wire types and view-model location
  tests/                   Unit, integration and end-to-end test locations
ts-sdks/packages/
  contracts/               Shared TypeScript, OpenAPI and protobuf boundaries
  node/                    Node merchant SDK, REST/gRPC and webhook helpers
  browser/                 Browser-safe login/signing/offline helper slots
docs/                      Architecture and implementation guide
scripts/                   Workspace build and bootstrap checks
```

MCP is a separate repository. There is no MCP server package or top-level workers package here.
Workers have their own entrypoint/process, share API domain services, and are registered only
in `api/src/worker.module.ts`.

**Scaffold only:** services, controllers, clients, repositories, processors and workers are
empty classes. Pages are empty route slots. No business endpoints, RPCs, consumers, queues,
DB schemas, integration calls, signing, transaction execution or authorization are implemented.

## Team starting points

Read [the implementation guide](docs/implementation-guide.md) to find where a use case belongs.
Read [the architecture map](docs/architecture.md) for dependency rules and source traceability.
The organization borrows Harbor's product boundaries, transport/domain/infra separation and
colocated workers while keeping NestJS and OctaP's technical decisions.

## Local commands

Use Node.js 24 LTS and npm 11. Install from the repository root.

```sh
npm ci
npm run lint
npm run build
npm run typecheck
npm run check:bootstrap
```

The build script follows workspace dependency order: shared contracts, SDKs, API and frontend.
Run separate processes after building:

```sh
npm run start:api
npm run start:worker
npm run dev:frontend
```

API binds to localhost:3000; no business route is registered. Frontend development binds to
localhost:3002; its pages are empty. The worker initializes its Nest context then exits because
no consumers are implemented. The API does not load WorkerModule.
Backend `.env` files are not loaded automatically; supply environment variables through your
shell or Node's --env-file option. Root [.env.example](.env.example) lists reserved private settings.

## Verification scope

Lint, builds, typechecks and Nest bootstrap validate scaffold composition, not business behavior.
No feature tests are claimed for placeholders. Move compilation remains unverified because
Sui CLI 1.79.0 could not download its framework dependency from GitHub in this environment.
