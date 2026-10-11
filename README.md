# OctaP Core

Core scaffold based on the [OctaP design knowledge base](https://github.com/OctaPointees/OctaP-Designing).
The frontend lives in [OctaP_Web](https://github.com/OctaPointees/OctaP_Web). MCP belongs to a separate repository.

## Repository ownership

```text
contracts/sui/             Sui Move package (no modules yet)
api/
  src/main.ts             NestJS HTTP entrypoint
  src/worker.ts           Separate worker process in the same API package
  src/api/                REST controllers and DTOs
  src/domain/             Feature modules and services (credits, rewards)
  src/infra/db/           Drizzle schema, repositories, RLS helper
  db/postgres/            Generated PostgreSQL migrations
ts-sdks/packages/
  contracts/              Public TypeScript wire types
  node/                   Merchant Node SDK (REST)
  browser/                Browser-safe client
docs/                     Architecture, implementation guide, roadmap
scripts/                  Ordered builds, unit tests, Nest bootstrap check
```

Core owns application rules, persistence, workers, on-chain invariants and SDK source.
Web owns routes, components, hooks, providers and presentation state. It consumes the public
API and versioned public packages; it never imports Core's domain or infrastructure files.
Private merchant and vendor credentials remain in Core.

**What exists today:** points (earn/redeem/balance/history) and vouchers, backed by PostgreSQL,
plus the SDK clients for them. Everything else in the design is listed in [the roadmap](docs/roadmap.md)
and has no code yet. New features are added as new files; there are no empty slots to fill.

Read [the roadmap](docs/roadmap.md), [the implementation guide](docs/implementation-guide.md) and
[architecture map](docs/architecture.md) before implementing a feature.
The folder organization borrows Harbor's transport/domain/infra separation while retaining NestJS.

## Local commands

Use Node.js 24 LTS and npm 11, from this repository root:

```sh
npm ci
npm run lint
npm run build
npm run typecheck
npm test
npm run check:bootstrap
npm run start:api
npm run start:worker
```

Build order is shared contracts, Node/browser SDKs, then API. API binds to localhost:3000 and
needs `DATABASE_URL` (see [.env.example](.env.example)); apply migrations with `npm run db:migrate`.
Only WorkerModule registers worker providers; the worker currently has none, so it initializes and exits.
Supply environment variables through your shell, a root `.env`, or Node's --env-file option.

## Public package handoff

OctaP_Web installs a committed npm tarball of @octap/contracts so a standalone clone builds
without a sibling Core checkout or registry credentials. The only source of these wire types is
`ts-sdks/packages/contracts`. This artifact carries types, not backend business rules.
See [the package handoff guide](docs/package-handoff.md) for regeneration and future registry releases.

## Verification scope

Lint, build, typecheck, unit tests (`npm test`) and the Nest bootstrap check run in CI.
Unit tests mock the database; there are no integration tests against PostgreSQL yet.
