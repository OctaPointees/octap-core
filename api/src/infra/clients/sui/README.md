# Sui chain client

Worker-only wrapper around `@octap/chain` (`contracts/sui`). Provides `earn`/`openAccount`;
deliberately no `redeem` — see `sui.client.ts` for why. Imported by `worker.module.ts`, never by
`infra/infrastructure.module.ts`: the signer key (`SUI_ISSUER_PRIVATE_KEY`) must only ever live in
the worker process's memory, not the internet-facing HTTP process.

Demo-scoped to one program/policy/IssuerCap from env (`SUI_PROGRAM_CONTROL_ID`,
`SUI_POLICY_VERSION_ID`, `SUI_ISSUER_CAP_ID`) applied to every organization — see
`contracts/sui/DEPLOYMENTS.md` and `docs/roadmap.md`'s `domain/programs` row for the real
per-organization mapping this will need before production use.
