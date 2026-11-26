# octap_audit deployments

Object ids per network for the published `octap_audit` package. Keep
`ts-sdks/packages/verify/src/networks.ts` (package, registry) and
`ts-sdks/packages/chain/src/evidence.ts` (`SealerCap`) in sync with this table by hand. The
verifier trusts only the ids it ships with, never ids a bundle claims.

The package is immutable, so any change to it is a fresh publish under new ids. Seals made under
an earlier package stay on-chain but are no longer trusted by the verifier.

## testnet

| Object | Id |
| --- | --- |
| Package (immutable, v1) | `0xd6cf2cfc77078d64b7a4a8b2cc7facc747812a43a38fc82096f2a0a181799c6c` |
| `evidence_seal::SealRegistry` (shared) | `0x117e9bdacdde8b491b51326c29d72ba2f4c756fac46eff52ab10782c95907784` |
| `evidence_seal::SealerCap` | `0xac58eb84562fc7ffd110e06d7b94f76b97ee518e04ac7e5b89997d90d7f2cad4` |
| `SealerCap` holder | issuer address `0x6109bef2e5420318a0484df8e2e6c4c6f2aec135fc6e33ba8d57197cac7a1f62` (`alias/octap-testnet-issuer`) |
| Publish tx | `APzWPP8JSBMuVBshfSCaV3b8ZJrqkE7iioeoqXay7ypc` |
| Cap transfer tx | `RBY2YrdazvHemmV8f4V88XWCq2mW7Zm5KRNKL21AMVw` |
| `make_immutable` tx | `5QNKXx68KSgpjSuTCgwqhrZA8HC6MFszK3VHtFESL8yR` |
| Publisher | deploy wallet `octap-admin` `0xc86cb60e8e32a8eb34ef7db1849ae91b9f0f26d483e716c42316bf9fe8a09b7d` |
| Toolchain | sui 1.79.0 |

Fresh publish for contiguous periods: `seal` now requires a period to start exactly where the
organization's latest seal ended (`ENotContiguous`), so no period with activity can be skipped and
an empty period is sealed as empty. The previous package `0xe72b1457...` (first OCT-77 build, which
allowed gaps) is abandoned on testnet.

## mainnet

Not published yet. Publish from this folder, transfer the `SealerCap` to the mainnet issuer
address, run `make_immutable` on the `UpgradeCap`, then fill in this table, `networks.ts` and
`MAINNET_OCTAP_AUDIT_CONFIG`.
