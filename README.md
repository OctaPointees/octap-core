# OctaP Source
Product scaffold for Sui contracts, the NestJS API, Next.js frontend, TypeScript SDKs, MCP and workers.
This folder sits next to the design knowledge base at [OctaP-Designing](https://github.com/OctaPointees/OctaP-Designing).

**Scaffold only:** modules, package boundaries, draft interfaces, empty worker classes
and empty Move modules. There are no business endpoints, tool handlers, background jobs,
database schemas, real service connections or transaction execution.

## Layout

| Location | Responsibility |
| --- | --- |
| api | NestJS REST gateway, Node gRPC adapter slots and shared backend libraries |
| frontend | Next.js merchant/admin portal and customer/POS reference route slots |
| mcp | Separate NestJS host for the future MCP Streamable HTTP adapter |
| workers | Shared-service worker composition and job slots |
| api/libs/core | Shared application modules, domain boundary and integration ports |
| api/libs/infrastructure | PostgreSQL, Redis, Sui, Enoki, ClickHouse, Walrus, Seal, Stripe, webhooks and realtime slots |
| api/libs/contracts | Draft shared types, REST and protobuf contract locations |
| ts-sdks | Node client and REST/gRPC transport interfaces, browser/webhook helper slots |
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
npm run dev:frontend
```

API and MCP hosts bind to localhost on ports 3000 and 3001; all requests return 404.
The MCP host is an empty HTTP shell, not yet a protocol server.
The worker initializes its Nest context and exits; no worker loop runs.
Environment variables may be supplied by the shell or Node's --env-file option;
.env files are not loaded automatically. [.env.example](.env.example) lists reserved settings.

See [architecture and source mapping](docs/architecture.md) for design traceability.
Dependencies are tooling choices for this scaffold, not proof of protocol or chain compatibility.

## Validation
Lint, a build from scratch, all eight workspace typechecks and Nest bootstrap passed locally.
Frontend routes are empty placeholders; no authentication or business UI is implemented.
A package-lock.json records resolved dependencies.
Move build was attempted with Sui CLI 1.79.0 but could not fetch the framework from
GitHub in this environment; Move compilation remains unverified.
