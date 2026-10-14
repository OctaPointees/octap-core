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
| `capabilities::IssuerCap` (sent to the deploy wallet; see note) | `0x937f16a5e8686f11b2bb4222d3bc6a4aef81443b71707246be219c55e45708c9` |
| `credit_account::CreditAccount` (demo beneficiary, alias `octap-demo-user`) | `0xc44cf23af9e8ac15231857dcf3b9c30c9898e3f4bec6613950168c41166fcf9a` |
| Demo beneficiary address (alias `octap-demo-user`) | `0x61576ee6119f66db3bf6cfeab99b2c9cc3314f596e3d98393c8bf66b21a1f576` |

The `IssuerCap` above is held by the same wallet as `AdminCap` purely for demo convenience — on
Sui, who can `earn` vs who can `pause`/rotate-policy is decided entirely by which capability
object a signer holds, not by which wallet it is, so splitting them into separate addresses later
is a plain `sui client transfer` of the `IssuerCap` object, not a contract or deployment change.
Production custody should move `IssuerCap` to the backend worker's own signer and keep `AdminCap`
off any server that runs continuously (see `contracts/sui/README.md`).

Testnet data is disposable. Losing these ids means recreating a program/policy/account, not a
republish of the package itself (`UpgradeCap` is what a republish needs).

## mainnet

Not deployed.
