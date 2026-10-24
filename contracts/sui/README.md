# Sui Move package

Implements the credit-earn/redeem slice of the object map in
[the roadmap](../../docs/roadmap.md): `capabilities`, `program_control`, `policy_version`,
`credit_account`, `operation_shard`, `budget_shard`. `campaign_authorization` and
`audit_manifest` are not built yet — they stay roadmap rows until a feature actually needs the
campaign machinery they require.

## Modules

- **`capabilities`** — `AdminCap` (program admin: create program, publish/activate policy,
  pause, mint `IssuerCap`s) and `IssuerCap` (service signer: `earn` only). Both are plain
  capability objects; which address holds one is a custody decision, not a contract concern —
  see the note in [DEPLOYMENTS.md](DEPLOYMENTS.md).
- **`program_control`** — `ProgramControl` is the shared object every other object's `program_id`
  is checked against. A program starts with no active policy, so `earn` is impossible until an
  admin publishes a policy and calls `activate_policy`.
- **`policy_version`** — each `PolicyVersion` is frozen immediately after `publish`; rotating the
  earn rate publishes a new version and re-activates, it never edits an old one.
- **`credit_account`** — one shared `CreditAccount` per beneficiary per program. Balances are a
  vector of expiry buckets, not a single integer: `redeem` always consumes the nearest-to-expiry
  bucket(s) first. `earn` computes the credited amount on-chain from `purchase_amount` and the
  active policy's `earn_bps` — the caller's claimed amount is never trusted. `redeem` requires
  `sender == beneficiary`; there is no entry point that moves credits between accounts or programs.
  `earn` also takes the program's `OperationShard` and `BudgetShard` that own its `operation_key`.
  Each `redeem`'s `reference` must be new to the account (`EDuplicateRedemption`).
  **Reversals** (issuer-only, own program, at most once each): `reverse_earn` removes exactly the
  bucket an earn created (each bucket carries a per-account `seq` the `OperationShard` recorded)
  and refunds its budget shard; it aborts `EBucketUnavailable` if that bucket was partly or fully
  spent, or has expired — never a short clawback, never another bucket's credits.
  `reverse_redeem` gives a redemption's amount back as a non-expiring balance (`non_expiring`),
  spent only after every live bucket, matching the Postgres ledger's bucketless add-back.
- **`operation_shard`** — on-chain anti-replay. Each program has `shard_count` shared
  `OperationShard`s, each a `Table` from every `operation_key` already earned under to what that
  earn did (account, amount, bucket `seq`, reversed?) — so a second `reverse_earn` of a key aborts
  `EAlreadyReversed`, and one for a key never earned `EUnknownOperation`. The owning shard is
  `sha2_256(operation_key)`, first 8 bytes read big-endian as a u64, mod `shard_count`
  (`shard_index_for`; `@octap/chain`'s `operationShardIndex` must match byte-for-byte). A replayed
  key aborts `EDuplicateOperation`; passing a shard that doesn't own the key aborts `EWrongShard`,
  so a replay can't dodge the shard that recorded it.
- **`budget_shard`** — the program's issuance budget, split evenly across `shard_count` shared
  `BudgetShard`s (remainder to shard 0) and debited by `earn`'s credited amount. A shard can't go
  negative (`EBudgetExceeded`) and never borrows from a sibling. It deliberately reuses the
  operation shard's index for the same key instead of load-balancing independently: that keeps
  the caller to one hash, at the cost of a hot key range draining its budget shard first. A
  drained shard is refilled with `top_up` (`AdminCap` only, never the `IssuerCap` signer); the
  API side is `ProgramsService.topUpBudget` / `scripts/top-up-budget.mjs`. `reverse_earn` refunds
  the reversed amount to the shard that owns the earn's key.

Shard mutations other than `create_shards`/`top_up` (`budget_shard::debit`/`refund`,
`operation_shard::check_and_record`/`mark_reversed`) are `public(package)`: a shard is a shared
object, so a public `&mut` function would let anyone drain a budget or pre-record a key.

Both shard kinds are created per program by `AdminCap` (`create_shards`), after the program's
policy and `IssuerCap` exist — see `api/src/infra/clients/sui/program-admin.client.ts`.

ProgramAdminCap must stay outside API workers. Points are non-transferable and tenant-isolated.

## Known gaps (intentional, tracked in the roadmap)

- **Shard count is 1 everywhere**: sharding only pays off under concurrent issuance load this
  project doesn't have yet. Raising it for a new program is a provisioning argument
  (`scripts/provision-program.mjs`), not a contract change; resharding an existing program isn't
  supported (its recorded keys live in the old shards).
- **Campaigns, audit manifests**: not built. See the roadmap's object map.
- **No on-chain clawback debt**: reversing an earn whose credits were already spent aborts
  (`EBucketUnavailable`) rather than recording a debt. Postgres still records the reversal (the
  balance goes negative there), so that account's chain and Postgres balances differ by what was
  spent until a human settles it — the worker marks the mirror command FAILED with the abort.
- **`reverse_earn` of an expired bucket aborts** for the same reason: the credits are gone.

## Tests

`contracts/sui/tests/credit_account_tests.move` covers the happy path (earn then redeem),
non-beneficiary redeem rejection, overspend rejection, expired-bucket exclusion from `spendable`,
earn rejection while a program is paused or with a cross-program `IssuerCap`, replayed
`operation_key` and wrong-shard rejection, budget-shard overdraw and per-shard isolation, budget
top-up (refill-then-earn, single-shard scope, wrong-program `AdminCap`, zero amount), and a
shard-index fixture shared with `api/tests/unit/infra/clients/sui.client.test.ts`.
`contracts/sui/tests/reversal_tests.move` covers both reversals: exact-bucket removal among
same-expiry buckets plus budget refund, abort after partial/full spend and after expiry, double
reversal, unknown key/reference, cross-program `IssuerCap`, another member's account, the
non-expiring add-back outliving its bucket and being spent last, and reused redeem references.
Run with:

```sh
sui move test
```

If dependency fetch fails with a git/TLS trust-anchor error, this environment's system git config
points `http.sslcainfo` at a file that doesn't exist; set `GIT_SSL_CAINFO` to a real CA bundle for
the command, e.g.:

```sh
GIT_SSL_CAINFO="$(python3 -c "import certifi;print(certifi.where())")" sui move build
```

## Deployment

See [DEPLOYMENTS.md](DEPLOYMENTS.md) for published package/object ids per network. After
publishing or changing a program/policy, update that table and re-run codegen in
`ts-sdks/packages/chain` (`npm run codegen` there).
