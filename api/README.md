# API and workers
One NestJS package with two entrypoints: `src/main.ts` for HTTP and `src/worker.ts` for background work.
Both import the same DomainModule, infrastructure, configuration and observability. Only
WorkerModule registers workers/processors; HTTP startup never starts job consumers.

## Layers

| Directory | Implement here |
| --- | --- |
| src/api/rest | Controllers and REST transport mapping |
| src/api/grpc | Core gRPC handlers and mapping to the same domain services |
| src/api/dto | Reviewed request validation and response mapping |
| src/api/guards | Identity, audience, tenant, scope, role and object checks |
| src/api/interceptors | Trace context, safe error mapping and serialization |
| src/domain/<feature> | Business use cases, invariants and domain contracts |
| src/domain/<feature>/*.worker.ts | Consumer lifecycle for that feature |
| src/domain/<feature>/*.processor.ts | Coordinate a single job through domain services |
| src/infra/db/repositories | SQL/ORM implementations and transactional persistence |
| src/infra/clients | Sui, Enoki, Stripe, ClickHouse, Walrus, Seal and webhook clients |
| src/infra/cache, queue, realtime | Cache, dispatch and push mechanics |
| src/config | Startup configuration and network/package/limit validation |
| src/observability | Logs, tracing, metrics and lag monitoring |
| db | PostgreSQL/ClickHouse migrations |
| scripts | Reviewed operational tooling |
| tests | Domain, adapter and protocol tests |

Every class is a scaffold slot. No query, route method, job execution or connection is implemented.
Domain services own logic; controllers never contain business rules. PostgreSQL commands/outbox
remain durable authority for acceptance; Redis cache/dispatch may be lost.
See [the team implementation guide](../docs/implementation-guide.md).

From the root: npm run start:api or npm run start:worker. From api/: npm run start or npm run start:worker.
Both require a root build first because API uses the shared contracts workspace.
