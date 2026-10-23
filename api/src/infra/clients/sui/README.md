# Sui chain client

Worker-only wrapper around `@octap/chain` (`contracts/sui`). Provides `earn`/`openAccount`;
deliberately no `redeem` — see `sui.client.ts` for why. Imported by `worker.module.ts`, never by
`infra/infrastructure.module.ts`: the signer key (`SUI_ISSUER_PRIVATE_KEY`) must only ever live in
the worker process's memory, not the internet-facing HTTP process.

Program-agnostic: `openAccount`/`earn` take the calling organization's `OctapProgramConfig`,
resolved from its `programs` row by `domain/programs`' `resolveProgramConfig`. Only the package id
is global — `@octap/chain`'s `TESTNET_OCTAP_PACKAGE_CONFIG` (a public on-chain id, committed, not an
env var), selected by the one `SUI_NETWORK` env var. See `contracts/sui/DEPLOYMENTS.md`.
