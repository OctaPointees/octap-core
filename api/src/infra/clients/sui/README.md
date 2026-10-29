# Sui chain client

Worker-only wrapper around `@octap/chain` (`contracts/sui`). Provides `earn`/`openAccount`;
deliberately no `redeem` — see `sui.client.ts` for why. Imported by `worker.module.ts`, never by
`infra/infrastructure.module.ts`: the signers must only ever be reachable from the worker process,
not the internet-facing HTTP process.

Signers (`signer.ts`): the issuer and program admin keys live in AWS KMS (`SUI_ISSUER_KMS_KEY_ID`,
`SUI_PROGRAM_ADMIN_KMS_KEY_ID`), signed through `@mysten/aws-kms-signer` with the AWS SDK's default
credential chain; the private keys never enter this process. A raw `SUI_*_PRIVATE_KEY` is a local
fallback only, refused on mainnet. Provisioning, IAM, and latency/cost: `docs/kms-signer.md`.

Program-agnostic: `openAccount`/`earn` take the calling organization's `OctapProgramConfig`,
resolved from its `programs` row by `domain/programs`' `resolveProgramConfig`. Only the package id
is global — `@octap/chain`'s `TESTNET_OCTAP_PACKAGE_CONFIG` (a public on-chain id, committed, not an
env var), selected by the one `SUI_NETWORK` env var. See `contracts/sui/DEPLOYMENTS.md`.
