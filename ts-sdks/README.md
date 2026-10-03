# TypeScript SDK scaffold
Node client/transport interfaces in src/client.ts and src/transports/.
Browser signing/login and webhook verification helper slots are separate.
The public package is @octap/sdk; it depends only on @octap/contracts.
No HTTP/gRPC calls, client factory, retries or verification are implemented.
