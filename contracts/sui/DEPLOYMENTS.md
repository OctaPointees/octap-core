# octap deployments

Object ids per network for the published `octap` package. Update this table on every publish,
upgrade, or program/policy change, and keep `ts-sdks/packages/chain/sui-codegen.config.ts` and
`ts-sdks/packages/chain/src/constants.ts`'s `TESTNET_OCTAP_DEMO_PROGRAM_CONFIG` in sync with it by
hand — there is no registry or indexer to read it from yet. These are public on-chain ids, not
secrets, so they're committed source, never env vars (see `constants.ts`'s doc comment).

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
| Cap holder (`UpgradeCap`, demo `AdminCap`) | deploy wallet (alias `octap-admin`) `0xc86cb60e8e32a8eb34ef7db1849ae91b9f0f26d483e716c42316bf9fe8a09b7d` |

Fresh publish for OCT-41 (shards changed `credit_account::earn`'s signature, which isn't
upgrade-compatible). The previous package `0x52f0fbc3...` and its demo program are abandoned on
testnet, not migrated.

### Demo program (disposable — testnet data only)

| Object | Id |
| --- | --- |
| `program_control::ProgramControl` (shared) | `0x899991c6ead71097af4c32b127678db511fa18e2070c3f7b5735dfc593ee82f2` |
| `capabilities::AdminCap` | `0xc485c5cfac0e35a8c5b752220dcd601b695601521f1d634cfe4b3a16bde98cd2` |
| `policy_version::PolicyVersion` (immutable, v1, 100 bps, 30-day expiry) | `0xaba658afa214b9c236e6c32083d3c195899df27b105a6ada7c5349a39ee0eb6a` |
| `capabilities::IssuerCap` (held by `SUI_ISSUER_PRIVATE_KEY`'s address, see note) | `0xf873b25be6a95790a70190e393e4facfb0885a037f69e644cb0861bcd629ceb3` |
| `operation_shard::OperationShard` (shard 0 of 1) | `0xd59a9b57e8c80d7fd98876c1a3b37aa823e0e3e11c265d4004b30e4bb486ee85` |
| `budget_shard::BudgetShard` (shard 0 of 1, 1,000,000,000 credits at creation) | `0x7544cb71e0359c11be7c70a688f1fd5855ba126f5e0b5106a1509ce4d3bab833` |
| `credit_account::CreditAccount` (demo beneficiary, alias `octap-demo-user`) | `0xcb19f024721a1f40a4cbdf651916e162b43d3415efd94e33ff37d4d6de633fed` |
| Demo beneficiary address (alias `octap-demo-user`) | `0x61576ee6119f66db3bf6cfeab99b2c9cc3314f596e3d98393c8bf66b21a1f576` |
| Issuer address (`SUI_ISSUER_PRIVATE_KEY`) | `0x6109bef2e5420318a0484df8e2e6c4c6f2aec135fc6e33ba8d57197cac7a1f62` |

Setup txs: create program `FP9JhnkF6qH9EDFb9nPTfzJhmbtsoHkA97iSo4vRcPzB`, publish policy
`6UX1jBprLYGCAr21MHMJY8z3cB3TfdoaVvMjpdwTcgEr`, activate policy + issue cap + create shards
`CqoN63VkKitYm1rtf1tGSu8SRWbe5g9wtjBhEsLTZMCd`. Live-verified through `SuiClientService`: open
account `6GWMxwvhDr39ei3uDFrFMk6rhaS3VN4Yg7uY7oGubjVA`, earn `H5ha4FVcPCU2ZFrNsD7tt22vLyaZVe2W6BiqMycWSa8q`
(100 credits, budget shard left at 999,999,900); replaying the same `operation_key` aborted with
`operation_shard::check_and_record` code 2 (`EDuplicateOperation`) at simulation.

`AdminCap` stays on the deploy wallet (`octap-admin`); `IssuerCap` above was minted directly to
the issuer's own generated keypair, whose secret only ever lives in a local `.env`'s
`SUI_ISSUER_PRIVATE_KEY` (never committed, never shown in a terminal transcript) — this is the key
`ChainSubmitWorker` actually signs with. Splitting `AdminCap`/`IssuerCap` across addresses is a
custody choice, not a contract one: who can `earn` vs who can `pause`/rotate-policy is decided
entirely by which capability object a signer holds, so moving `IssuerCap` again later is just
`sui client transfer`, never a contract or deployment change.

Testnet data is disposable. Losing these ids means recreating a program/policy/shards/account, not
a republish of the package itself (`UpgradeCap` is what an upgrade needs). Any local dev-DB row
pointing at the old package's objects (`credit_ownerships.sui_credit_account_id`, `programs`) must
be cleared after a republish — the worker reopens accounts on demand.

## mainnet

Not deployed.
