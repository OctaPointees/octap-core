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
| Package (`published-at` = `original-id`, v1) | `0xcad75786a5bd6b2157fcbed5bb81c819f1224111fa3f8c599e904ce7b55c041e` |
| `0x2::package::UpgradeCap` | `0x7eca84e4a590fe6fdb0d93f34b96051d149d3746fcee89505437aecb89ad6d07` |
| Publish tx | `4okeG9cudnSnZcAtBv6GjJgL6AhfR4Ytko5GPtTwyQE3` |
| Toolchain | sui 1.79.0-46f18562f1f5 |
| `UpgradeCap` holder | deploy wallet (alias `octap-admin`) `0xc86cb60e8e32a8eb34ef7db1849ae91b9f0f26d483e716c42316bf9fe8a09b7d` |
| Issuer address (issuer signer, receives each program's `IssuerCap`) | `0x6109bef2e5420318a0484df8e2e6c4c6f2aec135fc6e33ba8d57197cac7a1f62` |

Fresh publish for OCT-291 (`VoucherTerms.use_duration_ms`): each customer's voucher can be usable for
a duration from its own `issued_at_ms`, capped by `expires_at_ms` (`voucher_terms::use_deadline_ms`,
`is_usable`; `is_unexpired` is gone). `publish_terms` takes the duration, and the struct and its event
changed shape, which is not upgrade-compatible. `VoucherGranted` and `VoucherClaimed` also carry the
record's `issued_at_ms`, so Core computes the same deadline as the chain however late it confirms. The
previous package `0x775796f0...` (OCT-279), and `0x98f3f9b5...` (this PR's first build, never on `dev`),
are abandoned on testnet, not migrated.

Fresh publish for OCT-279 (`voucher_terms`, and `claim_voucher`, `grant_voucher`, `use_voucher`,
`cancel_voucher` in `credit_account`): `CreditAccount` gained a `vouchers` table, which is not
upgrade-compatible, and `reverse_redeem` now refuses an unused voucher. Claims and grants also need
at least 24 hours of use left on the terms (`voucher_terms::is_issuable`, which replaced `is_active`).
The previous packages `0xc44f5ce0...` (earlier OCT-279 build) and `0x0e7f5c0b...` (OCT-50) are
abandoned on testnet, not migrated.

Fresh publish for OCT-50 (`reverse_earn`/`reverse_redeem`): `Bucket`, `CreditAccount` and
`OperationShard`'s table value changed shape, and `budget_shard::debit` /
`operation_shard::check_and_record` went from `public` to `public(package)` — none of which is
upgrade-compatible. Even an additive change is published fresh here: an upgrade gives the package
a new id while event types keep the original one, and the indexer filters events by the
configured package id. The previous packages `0x8ee8b8b9...` (OCT-81), `0xda317c68...` (OCT-41)
and `0x52f0fbc3...` are abandoned on testnet, not migrated — and must not be used: on all three,
anyone can call `budget_shard::debit` / `operation_shard::check_and_record` on a program's shared
shards directly.

## Programs

There is no committed program. Each organization's `ProgramControl`, `PolicyVersion`,
`IssuerCap` and operation/budget shards are created by `scripts/provision-program.mjs` (signed by
the program admin signer, which keeps that program's `AdminCap`) and recorded in that
organization's `programs` row — the API reads them from there for every earn, never from source.

`IssuerCap`s are minted directly to the issuer address above — the key `ChainSubmitWorker` signs
with. That key lives in AWS KMS as `alias/octap-testnet-issuer` (`SUI_ISSUER_KMS_KEY_ID`, see
`docs/kms-signer.md`), imported from the original raw key, so the address above is unchanged. Who can `earn` vs who can `pause`/rotate policy is decided
entirely by which capability object a signer holds, so moving an `IssuerCap` later is just
`sui client transfer`, never a contract or deployment change.

Testnet data is disposable: after a republish, every `programs` row and every
`credit_ownerships.sui_credit_account_id` points at the old package's objects. Clear them and
re-provision; the worker reopens accounts on demand.

## mainnet

Not deployed.
