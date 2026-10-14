# Sui chain client

Worker-only wrapper around `@octap/chain` (`contracts/sui`). Provides `earn`/`openAccount`;
deliberately no `redeem` — see `sui.client.ts` for why. Imported by `worker.module.ts`, never by
`infra/infrastructure.module.ts`: the signer key (`SUI_ISSUER_PRIVATE_KEY`) must only ever live in
the worker process's memory, not the internet-facing HTTP process.

Demo-scoped to one program/policy/IssuerCap applied to every organization — those object ids live
in `@octap/chain`'s `TESTNET_OCTAP_DEMO_PROGRAM_CONFIG` (public on-chain ids, committed, not env
vars — same pattern Harbor uses for `TESTNET_BUCKET_GROUP_PACKAGE_CONFIG`), selected by the one
`SUI_NETWORK` env var. See `contracts/sui/DEPLOYMENTS.md` and `docs/roadmap.md`'s `domain/programs`
row for the real per-organization mapping this will need before production use.
