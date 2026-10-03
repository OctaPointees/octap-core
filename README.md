# OctaP Core

Core scaffold based on the [OctaP design knowledge base](https://github.com/OctaPointees/OctaP-Designing).
The frontend lives in [OctaP_Web](https://github.com/OctaPointees/OctaP_Web). MCP belongs to a separate repository.

## Repository ownership

```text
contracts/sui/             Move object modules, tests and contract tooling slots
api/
  src/main.ts             NestJS HTTP entrypoint
  src/worker.ts           Separate worker process in the same API package
  src/api/                REST/gRPC adapters, DTOs, guards and interceptors
  src/domain/             Feature modules, services and colocated workers/processors
  src/infra/              Repositories, vendor clients, cache, queue and realtime
  src/config/             Startup configuration slots
  src/observability/      Shared telemetry slots
  db/                     PostgreSQL and ClickHouse migration slots
  tests/                  Unit, integration and contract tests
  scripts/                Operational tooling slots
ts-sdks/packages/
  contracts/              Public TypeScript types, OpenAPI and protobuf boundaries
  node/                   Merchant Node SDK transport and webhook slots
  browser/                Browser-safe login, signing and offline helper slots
docs/                     Architecture map and implementation guide
scripts/                  Ordered workspace builds and Nest bootstrap checks
```

Core owns application rules, persistence, workers, on-chain invariants and SDK source.
Web owns routes, components, hooks, providers and presentation state. It consumes the public
API and versioned public packages; it never imports Core's domain or infrastructure files.
Private merchant and vendor credentials remain in Core.

**Scaffold only:** service/controller/repository/client/worker classes and Move modules reserve
implementation locations. There are no business endpoints, consumers, database schemas,
external calls, transaction execution or authorization behavior.

Read [the implementation guide](docs/implementation-guide.md) and
[architecture map](docs/architecture.md) before implementing a feature.
The folder organization borrows Harbor's transport/domain/infra separation while retaining NestJS.

## Local commands

Use Node.js 24 LTS and npm 11, from this repository root:

```sh
npm ci
npm run lint
npm run build
npm run typecheck
npm run check:bootstrap
npm run start:api
npm run start:worker
```

Build order is shared contracts, Node/browser SDKs, then API. API binds to localhost:3000;
no business routes are registered. Only WorkerModule registers worker providers. The worker
initializes its Nest context and exits because consumers are still placeholders.
Supply environment variables through your shell or Node's --env-file option; [.env.example](.env.example)
lists reserved private settings.

## Public package handoff

OctaP_Web installs a committed npm tarball of @octap/contracts so a standalone clone builds
without a sibling Core checkout or registry credentials. The only source of these wire types is
`ts-sdks/packages/contracts`. This artifact carries types, not backend business rules.
See [the package handoff guide](docs/package-handoff.md) for regeneration and future registry releases.

## Verification scope

Lint, build, typecheck and Nest bootstrap validate scaffold composition. Feature behavior remains
unimplemented. Move compilation remains unverified because the Sui CLI could not download
its framework dependency from GitHub in this environment.
