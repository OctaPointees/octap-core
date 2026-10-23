# octap deployments

Package ids per network for the published `octap` package. Update this table on every publish or
upgrade, and keep `ts-sdks/packages/chain/sui-codegen.config.ts` and
`ts-sdks/packages/chain/src/constants.ts`'s `TESTNET_OCTAP_PACKAGE_CONFIG` in sync with it by
hand — there is no registry or indexer to read it from yet. These are public on-chain ids, not
secrets, so they're committed source, never env vars.

A change to the Move package is republished (or upgraded) on its PR branch *before* merge, with
the new ids committed in that same PR — main never points at a deployment that doesn't match its
Move source.

## testnet

| Object | Id |
| --- | --- |
| Package (`published-at` = `original-id`, v1) | `0xda317c683fd6cbabc25d03f04c5aa27711cf3c5ffe4e3ef79c154174da7c3a60` |
| `0x2::package::UpgradeCap` | `0x46025cdff8d43d5828435118342c2b47060da9ddff8af4ca20744d9ccfeb9aa7` |
| Publish tx | `E1d9NWXbijzuAGpRktJ5ghiZkmZPZBFttNjXzfQmEfAF` |
| Toolchain | sui 1.79.0-46f18562f1f5 |
| `UpgradeCap` holder | deploy wallet (alias `octap-admin`) `0xc86cb60e8e32a8eb34ef7db1849ae91b9f0f26d483e716c42316bf9fe8a09b7d` |
| Issuer address (`SUI_ISSUER_PRIVATE_KEY`, receives each program's `IssuerCap`) | `0x6109bef2e5420318a0484df8e2e6c4c6f2aec135fc6e33ba8d57197cac7a1f62` |

Fresh publish for OCT-41 (shards changed `credit_account::earn`'s signature, which isn't
upgrade-compatible). The previous package `0x52f0fbc3...` is abandoned on testnet, not migrated.

## Programs

There is no committed program. Each organization's `ProgramControl`, `PolicyVersion`,
`IssuerCap` and operation/budget shards are created by `scripts/provision-program.mjs` (signed by
`SUI_PROGRAM_ADMIN_PRIVATE_KEY`, which keeps that program's `AdminCap`) and recorded in that
organization's `programs` row — the API reads them from there for every earn, never from source.

`IssuerCap`s are minted directly to the issuer address above, whose secret only ever lives in a
local `.env`'s `SUI_ISSUER_PRIVATE_KEY` (never committed, never shown in a terminal transcript) —
the key `ChainSubmitWorker` signs with. Who can `earn` vs who can `pause`/rotate policy is decided
entirely by which capability object a signer holds, so moving an `IssuerCap` later is just
`sui client transfer`, never a contract or deployment change.

Testnet data is disposable: after a republish, every `programs` row and every
`credit_ownerships.sui_credit_account_id` points at the old package's objects. Clear them and
re-provision; the worker reopens accounts on demand.

## mainnet

Not deployed.
