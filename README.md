# OctaP Core

Core scaffold based on the [OctaP design knowledge base](https://github.com/OctaPointees/OctaP-Designing).
The frontend lives in [OctaP_Web](https://github.com/OctaPointees/OctaP_Web). MCP belongs to a separate repository.

## Repository ownership

```text
contracts/sui/             Sui Move package: capabilities, program_control, policy_version, credit_account
api/
  src/main.ts             NestJS HTTP entrypoint
  src/worker.ts           Separate worker process in the same API package
  src/api/                REST controllers and DTOs
  src/domain/             Feature modules and services (credits, rewards, chain-submit worker)
  src/infra/db/           Drizzle schema, repositories, RLS helper
  src/infra/clients/sui/  Worker-only Sui chain adapter (signer key never in the HTTP process)
  db/postgres/            Generated PostgreSQL migrations
ts-sdks/packages/
  contracts/              Public TypeScript wire types
  chain/                  Backend-only: @mysten/codegen bindings + chain client (not published)
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
plus the SDK clients for them. Earning points now really lands on Sui testnet: the HTTP request
durably accepts the command in Postgres and returns immediately, a worker dispatches it to the
`octap` Move package, and confirmed amounts flow back into the PG projection — see
`docs/roadmap.md`'s known gaps for exactly what's still demo-scoped (one program for all
organizations, redeem stays off-chain pending zkLogin). Everything else in the design is listed in
[the roadmap](docs/roadmap.md) and has no code yet. New features are added as new files; there are
no empty slots to fill.

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
npm test                  # unit tests (no infrastructure needed)
npm run test:integration  # real Postgres/Redis via testcontainers (Docker or Podman)
npm run test:coverage     # both, with the coverage gate CI enforces
npm run check:bootstrap
npm run start:api
npm run start:worker
```

Build order is shared contracts, the chain package, Node/browser SDKs, then API. API binds to
localhost:3000 and needs `DATABASE_URL` (see [.env.example](.env.example)); apply migrations with
`npm run db:migrate`. Only WorkerModule registers worker providers; it now runs
`ChainSubmitWorker`, which needs the `SUI_*` variables in `.env.example` to actually dispatch (it
still boots and polls harmlessly without them — only a claimed operation's chain call fails).
Supply environment variables through your shell, a root `.env`, or Node's --env-file option.

## Public package handoff

OctaP_Web installs a committed npm tarball of @octap/contracts so a standalone clone builds
without a sibling Core checkout or registry credentials. The only source of these wire types is
`ts-sdks/packages/contracts`. This artifact carries types, not backend business rules.
See [the package handoff guide](docs/package-handoff.md) for regeneration and future registry releases.

## Verification scope

Lint, build, typecheck, unit tests, integration tests against real PostgreSQL/Redis (with a
coverage gate) and the Nest bootstrap check run in CI. See [api/tests/README.md](api/tests/README.md).
Chain and Enoki calls are faked in tests; nothing in CI touches Sui testnet.
