# Shared API contracts
`src/` holds draft framework-free TypeScript wire types. `openapi/` and `proto/` reserve
reviewed REST and gRPC contracts. This package is separate from on-chain Move contracts.
Points/u64 values use decimal strings; balance types preserve confirmed, pending and checkpoint fields.
Physical schemas, runtime validation and API/SDK code generation are unimplemented.
