# API scaffold
NestJS REST/Node gRPC gateway in src/, with shared backend libraries in libs/:
- core: application modules, domain boundary and integration ports.
- infrastructure: vendor adapters and persistence/integration slots.
- contracts: draft shared TypeScript, OpenAPI and protobuf boundaries.

MCP and workers import the same @octap/core and @octap/infrastructure packages.
No business endpoints, schema migrations or external clients are implemented.
