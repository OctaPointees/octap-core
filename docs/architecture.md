# Scaffold architecture and design traceability

## Authoritative inputs for this scaffold
- [Solution architecture](https://github.com/OctaPointees/OctaP-Designing/blob/main/brainstorming/outputs/03-solution-architecture.md): modular monolith, adapters, workers, sources of truth and Sui objects.
- [Product and scope](https://github.com/OctaPointees/OctaP-Designing/blob/main/brainstorming/outputs/02-product-and-scope.md): roles, SDK/MCP boundaries and point semantics.
- [Conceptual ERD explanation](https://github.com/OctaPointees/OctaP-Designing/blob/main/reports/report-1/erd/report-explanation.md): entity vocabulary, not a physical database schema.
- [Report 1 use-case model](https://github.com/OctaPointees/OctaP-Designing/blob/main/reports/report-1/usecase.drawio.xml): functional boundaries.
- [Report 1 and Report 2](https://github.com/OctaPointees/OctaP-Designing/tree/main/reports) provide product scope and planning context.
- Report 3 remains a continuously edited template and is not a technical baseline for this scaffold.

## Component map
| Design section | Scaffold location | Boundary |
| --- | --- | --- |
| 3.1, 3.11 | api/libs/infrastructure/src/postgres | Durable commands, outbox, approvals and projections |
| 3.1, 3.12 | api/libs/infrastructure/src/redis | Disposable cache and rate limits |
| 3.2, ADR 00/05 | api/src/transports | REST and Node gRPC |
| 3.2 | frontend/src/app | Separate merchant/admin layouts and customer/POS reference route slots |
| 3.2, ADR 06 | api/libs/core/src/application.module.ts | Application services shared by all adapters |
| 3.2 | workers/src/jobs | Transaction, projection, checkpoint, webhook, analytics, audit and reconciliation slots |
| 3.4 | contracts/sui/sources | ProgramControl, PolicyVersion, caps, shards, account, receipt, authorization and manifest |
| 3.5 | api/libs/infrastructure/src/enoki | Google zkLogin and sponsorship |
| 3.5 | api/libs/core/src/application/authorization | Tenant, role, object and approval boundary |
| 3.6 | api/libs/core/src/application/operations | Idempotent command/state recovery boundary |
| 3.7 | ts-sdks; api/libs/contracts | Node SDK, transport parity and contract locations |
| 3.8 | mcp | MCP HTTP, OAuth, tool and prompt slots |
| 3.9 | ts-sdks/src/browser | Login/signing and offline earn-intent helpers |
| 3.10 | infrastructure walrus/seal modules; audit worker | Encrypted evidence outside checkout |
| 3.11 | infrastructure clickhouse module; analytics worker | Derived analytics only |
| 3.12 | infrastructure stripe module; billing worker | Merchant test billing |
| 3.2 | infrastructure realtime module | Socket.IO push; snapshots remain API-owned |

## Dependency direction
API / MCP / workers -> core application services -> core ports.
Infrastructure owns vendor-specific adapters. SDK depends on shared contracts only.
Core never imports vendor SDKs, HTTP controllers or MCP tools.
Nest modules import shared application modules without duplicating domain behavior.

## Implementation boundaries
Empty Nest feature services reserve use-case locations; they expose no operations.
Infrastructure modules deliberately have no clients or providers bound to the ports.
Ports reserve component identities; final method contracts await API/schema design.
Draft balance types retain the confirmed/pending/checkpoint distinction and decimal strings.
No runtime validation, calculations, retries, authorization or persistence are implemented.
No Move object structs or public entry functions are defined.

Future implementation must preserve: chain authority for confirmed points;
durable PostgreSQL command acceptance before enqueue; tenant isolation;
customer signatures for redemption; bounded campaign approval;
non-transferable points; and backend-only sponsorship credentials.
The scaffold does not enforce these invariants yet.

## Tooling and compatibility
npm workspaces keep one source tree with independent API, MCP and worker entrypoints.
TypeScript emits ESM and Nest decorator metadata. SDK and contracts remain framework-free.
The top-level product directories are contracts/, api/, frontend/, ts-sdks/, mcp/ and workers/.
Shared backend libraries live under api/libs/ and remain independent npm workspaces.
The Next.js frontend contains only root and route layouts plus empty pages;
authentication, authorization and visual/business UI are deferred.
The knowledge base targets MCP 2026-07-28 and a Sui gRPC adapter.
Library imports reserve those boundaries; protocol and network compatibility are not claimed.
Physical DB schema, generated OpenAPI/protobuf messages, Move toolchain pinning,
external integrations, deployment configuration and frontend business UI remain outside this scaffold.
