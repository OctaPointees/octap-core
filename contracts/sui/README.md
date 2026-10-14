# Sui Move package

Implements the credit-earn/redeem slice of the object map in
[the roadmap](../../docs/roadmap.md): `capabilities`, `program_control`, `policy_version`,
`credit_account`. `budget_shard`, `operation_shard`, `campaign_authorization`, and
`audit_manifest` are not built yet — they stay roadmap rows until a feature actually needs the
sharding/anti-replay/campaign machinery they require.

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

ProgramAdminCap must stay outside API workers. Points are non-transferable and tenant-isolated.

## Known gaps (intentional, tracked in the roadmap)

- **Operation replay**: `earn`'s `operation_key` is recorded on the emitted event for off-chain
  correlation but is not checked against an on-chain anti-replay table yet. PostgreSQL's
  idempotency key already rejects a duplicate command before it reaches this module (see
  `docs/architecture.md`); a sharded `OperationShard` is future work once issuance volume needs
  one shared object's worth of replay-checking to not become a hot-spot.
- **Budgets, campaigns, audit manifests**: not built. See the roadmap's object map.
- **Reversal/clawback**: no `reverse`/`clawback` entry points yet; `docs/roadmap.md` lists
  `credits/reversal.service.ts` and `credits/expiry.service.ts` as not started on the API side too.

## Tests

`contracts/sui/tests/credit_account_tests.move` covers the happy path (earn then redeem),
non-beneficiary redeem rejection, overspend rejection, expired-bucket exclusion from `spendable`,
and earn rejection while a program is paused. Run with:

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
