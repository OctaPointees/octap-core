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
- **`operation_shard`** — on-chain anti-replay. Each program has `shard_count` shared
  `OperationShard`s, each a `Table` of `operation_key`s already earned under. The owning shard is
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
  API side is `ProgramsService.topUpBudget` / `scripts/top-up-budget.mjs`.

Both shard kinds are created per program by `AdminCap` (`create_shards`), after the program's
policy and `IssuerCap` exist — see `api/src/infra/clients/sui/program-admin.client.ts`.

ProgramAdminCap must stay outside API workers. Points are non-transferable and tenant-isolated.

## Known gaps (intentional, tracked in the roadmap)

- **Shard count is 1 everywhere**: sharding only pays off under concurrent issuance load this
  project doesn't have yet. Raising it for a new program is a provisioning argument
  (`scripts/provision-program.mjs`), not a contract change; resharding an existing program isn't
  supported (its recorded keys live in the old shards).
- **Campaigns, audit manifests**: not built. See the roadmap's object map.
- **Reversal/clawback**: no `reverse`/`clawback` entry points yet; `docs/roadmap.md` lists
  `credits/reversal.service.ts` and `credits/expiry.service.ts` as not started on the API side too.

## Tests

`contracts/sui/tests/credit_account_tests.move` covers the happy path (earn then redeem),
non-beneficiary redeem rejection, overspend rejection, expired-bucket exclusion from `spendable`,
earn rejection while a program is paused or with a cross-program `IssuerCap`, replayed
`operation_key` and wrong-shard rejection, budget-shard overdraw and per-shard isolation, budget
top-up (refill-then-earn, single-shard scope, wrong-program `AdminCap`, zero amount), and a
shard-index fixture shared with `api/tests/unit/infra/clients/sui.client.test.ts`. Run with:

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
