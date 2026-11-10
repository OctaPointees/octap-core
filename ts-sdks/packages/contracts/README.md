# Shared API contracts
Framework-free TypeScript wire types used by the API and both SDKs: `src/loyalty.ts` (points)
and `src/rewards.ts` (vouchers). This package is separate from on-chain Move contracts.
These types also drive the OpenAPI document's request and response schemas (`npm run openapi:schemas`,
see `api/README.md`): a JSDoc comment on a field becomes its description there, and `@format uuid`
becomes its format. Runtime validation and protobuf generation do not exist yet.
