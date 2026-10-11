# Team implementation guide

The tree only contains working code. To add a feature, pick an item from [the roadmap](roadmap.md),
create the files it needs following the pattern below, and move its roadmap row to **Implemented**
in the same pull request. Do not add empty classes or folders for future work; add a roadmap row instead.

`credits` and `rewards` are the reference implementations. Copy their shape.

## Adding an API feature

Paths are relative to `api/src`.

1. **Wire types**: add the request/response types to `ts-sdks/packages/contracts/src/<feature>.ts`
   and export them from its `index.ts`.
2. **Schema**: add or change tables in `infra/db/schema/<feature>.schema.ts`, export from
   `schema/index.ts`, then run `npm run db:generate` and commit the migration under `api/db/postgres/migrations`.
3. **Repository**: `infra/db/repositories/<feature>.repository.ts` injects `DRIZZLE_DB`.
   Register it in `infra/db/postgres.module.ts`. Use `withRls` from `infra/db/rls.ts` for tenant-scoped queries.
4. **Domain**: `domain/<feature>/<feature>.service.ts` (split into `<use-case>.service.ts` when a
   flow is large) plus `<feature>.module.ts`. Add the module to `domain/domain.module.ts`.
   Business rules live here; services depend on repositories, never on controllers.
5. **Transport**: `api/rest/<feature>.controller.ts` and body DTOs in `api/dto/<feature>.dto.ts`.
   Register the controller in `api/rest/rest.module.ts`. Controllers only map protocol details.
6. **SDK**: add client methods in `ts-sdks/packages/node/src/client.ts` (and the browser client if
   customers call it directly).
7. **Tests**: add unit tests with mocked repositories/fetch to `scripts/test-unit.mjs`.
8. **Docs**: add a short `README.md` in the domain folder and update [the roadmap](roadmap.md).

Add a vendor client under `infra/clients/<vendor>/` and a new infrastructure module (imported by
`infra/infrastructure.module.ts`) only when a feature actually calls that vendor. Add its
environment variables to `.env.example` in the same change.

## Workers

HTTP and worker share one package but run as separate processes. A job lives next to its
feature: `<job>.worker.ts` owns consumer lifecycle, concurrency and shutdown; `<job>.processor.ts`
coordinates one job through the feature's domain services. Register both only in
`worker.module.ts`; `npm run check:bootstrap` fails if `AppModule` loads the worker module.
Workers never duplicate rules from HTTP handlers.

## Rules that every feature keeps

- Sui is authoritative for confirmed points; PostgreSQL owns commands, idempotency, outbox and
  approvals. Durable command acceptance precedes chain dispatch.
- Customer redemption requires beneficiary consent. Points are non-transferable and tenant-isolated.
- Domain code never imports controllers or vendor SDKs directly; infrastructure owns vendor details.
- Merchant and vendor credentials stay in Core; browser SDK options never carry them.
- Web consumes Core only through public packages (see [package handoff](package-handoff.md)),
  never through sibling folder imports.

## Frontend

Frontend work belongs in [OctaP_Web](https://github.com/OctaPointees/OctaP_Web). Server-side
permission checks remain required even when Web hides a surface.

## Checks

Run before opening a pull request:

```sh
npm run lint && npm run build && npm run typecheck && npm test && npm run check:bootstrap
```

Add runtime dependencies with the feature that uses them, not ahead of time.
