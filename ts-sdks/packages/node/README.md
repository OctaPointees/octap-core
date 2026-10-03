# Node merchant SDK
`src/client.ts` reserves the high-level client contract. `src/transports/rest.transport.ts`
and `grpc.transport.ts` reserve transport-specific implementation locations. `src/errors/`
is for typed errors/deadlines/retries; `src/webhooks/` is for raw-byte verification.
Public DTOs belong in the sibling contracts package. No client implementation exists.
Tests are split into unit, integration and contract slots. Do not import this package into
browser code carrying merchant credentials; browser helpers have their own package.
