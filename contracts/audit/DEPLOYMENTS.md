# octap_audit deployments

Object ids per network for the published `octap_audit` package. Keep
`ts-sdks/packages/verify/src/networks.ts` in sync with this table by hand. The verifier trusts
only the ids it ships with, never ids a bundle claims.

## testnet

| Object | Id |
| --- | --- |
| Package (immutable, v1) | `0xe72b14575bfabc48732c0cda1e5eef7d2ebfa0a81481b5fd1cd8547edfb74b84` |
| `evidence_seal::SealRegistry` (shared, initial version 1) | `0x23615d46f0727903f35b096a63ea02fa7cfa050c76742a37fddb307a7cdc8807` |
| `evidence_seal::SealerCap` | `0xf9863f1252dadd5306075039b26d9baa79548379a192276751a3efb0b3c056d7` |
| `SealerCap` holder | issuer address `0x6109bef2e5420318a0484df8e2e6c4c6f2aec135fc6e33ba8d57197cac7a1f62` (`alias/octap-testnet-issuer`) |
| Publish tx | `GcFH8DjNAL3SNWQBXFHQ3nbPqMXZXrMEeQDqyQGGSWHv` |
| Cap transfer tx | `3PK18iYGsHkLu7Qd6bqbELhWhAEsNa9b9SZbi4vFx7gq` |
| `make_immutable` tx | `B5AFf6o7UXNJ3Ti9KCympmb5T6nKAeQkiNCgNa6gYpkr` |
| Publisher | deploy wallet `octap-admin` `0xc86cb60e8e32a8eb34ef7db1849ae91b9f0f26d483e716c42316bf9fe8a09b7d` |
| Toolchain | sui 1.79.0 |

## mainnet

Not published yet. Publish from this folder, transfer the `SealerCap` to the mainnet issuer
address, run `make_immutable` on the `UpgradeCap`, then fill in this table and `networks.ts`.
