# Tests

Vitest, configured once in the root [`vitest.config.ts`](../../vitest.config.ts), with two projects.
Tests import TypeScript sources directly (`api/src`, and `@octap/*` resolves to each package's
`src`), so nothing needs building first.

| Project | Files | Needs | Command |
|---|---|---|---|
| `unit` | `api/tests/unit/**/*.test.ts`, `ts-sdks/packages/*/tests/**/*.test.ts` | nothing | `npm test` |
| `integration` | `api/tests/integration/**/*.integration.test.ts` | Docker or Podman | `npm run test:integration` |

`npm run test:coverage` runs both and enforces the coverage thresholds in `vitest.config.ts`;
that is what CI runs. `npm run test:watch` watches the unit project.

## Layout

```
api/tests/
  setup.ts                 reflect-metadata + silenced Nest logger, for every test
  helpers/                 stub<T>() typed doubles, fakeRedis(), fixtures (rows, chain results, ExecutionContext)
  unit/                    mirrors api/src: unit/domain/credits/earn.service.test.ts tests src/domain/credits/earn.service.ts
  integration/
    support/global-setup.ts  boots Postgres + Redis once per run, applies docker/postgres-init + drizzle migrations
    support/db.ts            connectTestDb(), resetDb(), seed* helpers
    support/app.ts           createTestApp(): the real AppModule over HTTP (supertest), chain clients faked
    repositories/            one spec per repository, against real Postgres (incl. row-lock races)
    http/                    end-to-end flows through controllers, guard, services, and the database
```

## Conventions

- **Unit**: construct the class directly with `stub<Repository>({ method: ... })` doubles. `stub`
  checks member names against the real class, so renaming a method breaks the tests that stub it.
  Assert on what was called and returned; drive every branch, including the failure paths.
- **Integration**: anything that writes SQL is tested here, not with mocks. Call `resetDb()` in
  `beforeEach`; files run one at a time because they share the database.
- **External services** (Sui, Enoki) are always faked: in integration tests by overriding
  `EnokiClient`/`SuiTransactionBuilderClient` (`createTestApp`) or passing a `SuiClientService`
  double to a processor. No test touches testnet.
- A new feature adds a unit spec for its service/processor and an integration spec for its
  repository methods and routes in the same pull request.

## Running integration tests locally

By default the global setup starts throwaway `postgres:17-alpine` and `redis:7-alpine`
containers through [testcontainers](https://node.testcontainers.org/).

- **Docker**: nothing to configure.
- **Podman (Windows)**: point testcontainers at Podman's Docker-compatible pipe, and disable Ryuk
  (its reaper container needs privileges Podman doesn't grant by default):

  ```sh
  DOCKER_HOST=npipe:////./pipe/podman-machine-default TESTCONTAINERS_RYUK_DISABLED=true npm run test:integration
  ```

- **Already-running servers** (e.g. `docker compose up -d`): skip containers entirely with
  `TEST_DATABASE_URL` (and `TEST_REDIS_URL`, default `redis://127.0.0.1:6379`). The database is
  created if missing and migrated; its name must contain `test`, because every test truncates it.

  ```sh
  TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/octap_test npm run test:integration
  ```
