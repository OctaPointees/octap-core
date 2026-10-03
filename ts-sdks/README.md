# TypeScript SDK workspace family

| Package | Role |
| --- | --- |
| packages/contracts (@octap/contracts) | Draft shared types and REST/protobuf contract locations |
| packages/node (@octap/sdk) | Merchant Node integration: REST/gRPC, deadlines, retries, webhook verification |
| packages/browser (@octap/browser-sdk) | Customer login/signing and offline earn-intent helpers |

The repository root manages all npm workspaces and one lockfile. The API and frontend consume
shared wire types from contracts; neither SDK imports API internals. Browser SDK options contain
no merchant credentials. All client factories, calls, signing and verification remain unimplemented.
