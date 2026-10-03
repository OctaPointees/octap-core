# OctaP Source
Backend scaffold for NestJS, MCP, the TypeScript SDK and Sui.
This folder sits next to the design knowledge base at [OctaP-Designing](https://github.com/OctaPointees/OctaP-Designing).

**Scaffold only:** modules, package boundaries, draft interfaces, empty worker classes
and empty Move modules. There are no business endpoints, tool handlers, background jobs,
database schemas, real service connections or transaction execution.

## Layout
| Location | Responsibility |
| --- | --- |
| apps/api | NestJS REST gateway and Node gRPC adapter slots |
| apps/mcp | Separate NestJS host for the future MCP Streamable HTTP adapter |
| apps/worker | Shared-service worker composition and job slots |
| packages/core | Shared application modules, domain boundary and integration ports |
| packages/infrastructure | PostgreSQL, Redis, Sui, Enoki, ClickHouse, Walrus, Seal, Stripe, webhooks and realtime slots |
| packages/contracts | Draft shared types, REST and protobuf contract locations |
| packages/sdk | Node client and REST/gRPC transport interfaces, browser/webhook helper slots |
| contracts/sui | Move module slots matching the technical object map |

## Local checks
Use Node.js 24 LTS and npm 11. Workspace packages build in dependency order.

```sh
npm install
npm run lint
npm run build
npm run typecheck
npm run check:bootstrap
```

After building:
```sh
npm run start:api
npm run start:mcp
npm run start:worker
```

API and MCP hosts bind to localhost on ports 3000 and 3001; all requests return 404.
The MCP host is an empty HTTP shell, not yet a protocol server.
The worker initializes its Nest context and exits; no worker loop runs.
Environment variables may be supplied by the shell or Node's --env-file option;
.env files are not loaded automatically. [.env.example](.env.example) lists reserved settings.

See [architecture and source mapping](docs/architecture.md) for design traceability.
Dependencies are tooling choices for this scaffold, not proof of protocol or chain compatibility.

## Validation
Lint, all seven TypeScript builds/typechecks, and Nest dependency-graph bootstrap
for API/MCP/worker passed locally. A package-lock.json records resolved dependencies.
Move build was attempted with Sui CLI 1.79.0 but could not fetch the framework from
GitHub in this environment; Move compilation remains unverified.
