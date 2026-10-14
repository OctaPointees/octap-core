# octap deployments

Object ids per network for the published `octap` package. Update this table on every publish,
upgrade, or program/policy change, and keep `ts-sdks/packages/chain/sui-codegen.config.ts` and
`ts-sdks/packages/chain/src/constants.ts`'s `TESTNET_OCTAP_DEMO_PROGRAM_CONFIG` in sync with it by
hand — there is no registry or indexer to read it from yet. These are public on-chain ids, not
secrets, so they're committed source, never env vars (see `constants.ts`'s doc comment).

## testnet

| Object | Id |
| --- | --- |
| Package (`published-at` = `original-id`, v1) | `0x52f0fbc38366047f14426a1401429e9f8c7d3c0945e54e411ef6bec911f8c392` |
| `0x2::package::UpgradeCap` | `0xcfba05779cda456b804a0ad18fe6cedff4ee72a45bb3f8df9ca71b104d5da093` |
| Publish tx | `Fkrz2h8Ukc5uY347n2XWHfJCRzKg5kX5nJRJDNGqV5Q8` |
| Toolchain | sui 1.79.0-46f18562f1f5 |
| Cap holder (`UpgradeCap`, demo `AdminCap`, demo `IssuerCap`) | deploy wallet (alias `octap-admin`) `0xc86cb60e8e32a8eb34ef7db1849ae91b9f0f26d483e716c42316bf9fe8a09b7d` |

### Demo program (disposable — testnet data only)

| Object | Id |
| --- | --- |
| `program_control::ProgramControl` (shared, initial version 1) | `0xa00660cbaf73253db7628ab3927f3234c6058ac0afa6d1fcb620d10fcf990434` |
| `capabilities::AdminCap` | `0x0b97b3270c979007844a29a90ec38748524fc3f2c3c799946435af527c1a3474` |
| `policy_version::PolicyVersion` (immutable, v1, 100 bps, 30-day expiry) | `0x627cc1e3152b501887ab05be1f24294abae34ea4135da658da3a47ddcddf0ba6` |
| `capabilities::IssuerCap` (used by `SUI_ISSUER_PRIVATE_KEY`, see note) | `0xf0896fc57c6edd4ada51fd20ea561e24cb7d962d8920ac29db6105cedf7455cc` |
| `credit_account::CreditAccount` (demo beneficiary, alias `octap-demo-user`) | `0xc44cf23af9e8ac15231857dcf3b9c30c9898e3f4bec6613950168c41166fcf9a` |
| Demo beneficiary address (alias `octap-demo-user`) | `0x61576ee6119f66db3bf6cfeab99b2c9cc3314f596e3d98393c8bf66b21a1f576` |

`AdminCap` stays on the deploy wallet (`octap-admin`); `IssuerCap` above was minted separately to
its own generated keypair, whose secret only ever lives in a local `.env`'s `SUI_ISSUER_PRIVATE_KEY`
(never committed, never shown in a terminal transcript) — this is the key `ChainSubmitWorker`
actually signs with. An earlier testnet `IssuerCap` (`0x937f16a5...`) was minted to the deploy
wallet itself during manual CLI/SDK verification before this service existed; it's unused now but
left alone rather than revoked (no revoke entry point exists yet — see
`contracts/sui/README.md`'s known gaps). Splitting `AdminCap`/`IssuerCap` across addresses is a
custody choice, not a contract one: who can `earn` vs who can `pause`/rotate-policy is decided
entirely by which capability object a signer holds, so moving `IssuerCap` again later is just
`sui client transfer`, never a contract or deployment change.

Testnet data is disposable. Losing these ids means recreating a program/policy/account, not a
republish of the package itself (`UpgradeCap` is what a republish needs).

## mainnet

Not deployed.
