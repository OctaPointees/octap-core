# Indexer domain

Projects Sui's own record of what happened onto PostgreSQL, independent of whether the
synchronous path (chain-submit worker, POS finalize) ever got to record it — the automated version
of "an UNKNOWN operation stays UNKNOWN until someone checks the chain by hand" (OCT-43).

- `checkpoint-indexer.worker.ts` / `.processor.ts`: polls `octap::credit_account` events through
  `SuiTransactionBuilderClient.listCreditAccountEvents` (gRPC `core.listEvents`, read-only, no
  signer). For each `CreditEarned` (matched by `operation_key` = the command's idempotency key) or
  `CreditRedeemed` (matched by `reference` = the redemption's receipt reference, which must equal
  the row's `receiptReference`: `posRedemptionReference` or `voucherClaimReference`) whose loyalty transaction
  is still PENDING, it calls the same `confirmEarnOnChain`/`confirmPosRedemptionOnChain` the
  synchronous paths use, and moves the operation to SUBMITTED. For an already-CONFIRMED row it
  still settles the operation (one left UNKNOWN by a failed `markSubmitted` after the ledger
  commit), and a `CreditEarned` backfills the earn's expiry bucket if it has none (OCT-49),
  then trims the member's buckets back to the balance, nearest expiry first, since points spent
  before buckets existed were never debited from one. `CreditExpired`
  runs the member's expiry sweep — usually a no-op, since balance reads already expire due
  buckets by clock. `CreditAccountOpened` is ignored. Registered only in `api/src/worker.module.ts`.
- **Cursor**: `indexer_cursors` holds one row per stream (`octap::credit_account`). Each page's
  business writes and its cursor advance commit in one transaction (`IndexerRepository.commitPage`),
  so a crash mid-page replays the whole page instead of skipping or double-applying it. The
  advance is conditional on the cursor not having moved, so a second instance loses cleanly.
- **First run starts at the stream head**, not genesis — deliberate: there is no historical backlog
  worth replaying in this demo. A null `cursor` reads forward from the oldest checkpoint the node
  still holds. If the node's retained window has no event of this package, the head lookup fails
  as pruned and is treated as an empty stream (null cursor).
- **Caught-up mark**: the cursor only moves when an event arrives, so on a quiet stream it ages.
  After every poll that finds nothing more, `caught_up_checkpoint` records the chain height read
  just before that poll, less a 1000-checkpoint margin for nodes lagging behind the load balancer.
  It means "no unprojected event at or below this checkpoint", and only grows. See "Pruned cursor".
- **Dedup**: every `confirm*/fail*OnChain` row-locks the loyalty transaction and acts only if it's
  still PENDING, so the indexer and the synchronous path can race and exactly one wins.
  `blockchain_transactions.digest` being unique is the backstop; the processor treats that
  violation as "already recorded".
- **Failed transactions** never reach this code: Sui discards an aborted transaction's events with
  the rest of its effects (verified on testnet: a simulated `redeem` that aborts with
  `ENotBeneficiary` returns zero events).

`asOfCheckpoint` on the balance response is this indexer's `last_checkpoint` (stream-wide, not
per member). `stale` is simply "any pending amount is nonzero"; comparing against the chain tip is
future work.

Env: `INDEXER_POLL_INTERVAL_MS` (5000), `INDEXER_PAGE_SIZE` (50), `INDEXER_MAX_PAGES_PER_POLL` (20).

## Pruned cursor

The fullnode keeps only a recent window of checkpoints, and testnet prunes fast. A stored cursor
older than that window makes `listEvents` fail with gRPC `OUT_OF_RANGE`, "requested data below
earliest available; lowest available checkpoint is N" (`ChainHistoryPrunedError`). The lower
bound N differs between the nodes behind the public endpoint, so it is read from the refusing
node's own error.

**What the worker does on its own.** Any event after the cursor sits above
`caught_up_checkpoint`, since an empty poll saw none up to there.

- Mark ≥ N − 1: every such event is still retained, so the worker sets `cursor` to null and reads
  on from N. It logs a warning and skips nothing. This is the usual case: the worker was running
  and the stream was just quiet.
- Otherwise (no mark, the mark is below N − 1, or the error has no N): the worker was down longer
  than the window. The gap may hold events the indexer can no longer read, so every poll fails
  with "the gap may hold events the indexer can no longer read". That needs the runbook below.

The resume-at-head sentinel (`RESUME_AT_HEAD`) is replaced in place, never deleted first, and a
failed head lookup leaves it for the next poll.

### Runbook: the worker refuses a pruned or lost cursor

**Symptom.** Every poll logs one of these:

```
ERROR [CheckpointIndexerWorker] poll failed: octap::credit_account cursor was pruned by the node (...) the gap may hold events the indexer can no longer read. ...
ERROR [CheckpointIndexerWorker] poll failed: octap::credit_account cursor is unset but loyalty_transactions already has rows — refusing to start at the chain head ...
```

Restarting changes nothing: the worker reads the same row from `indexer_cursors`.

**What skipping costs.** The chain stays the source of truth; nothing is lost on-chain. The
synchronous path has already recorded every transaction it finished, so the only rows at risk are
ones it did not finish, which the indexer would have repaired from the skipped events:

- an earn or redemption left `PENDING` (pending points never become available, or stay held);
- an operation left `UNKNOWN`;
- a voucher claim left `RESERVED`, or a voucher used on-chain still shown `AVAILABLE`;
- an earn's missing expiry bucket (OCT-49) that is never backfilled.

`CreditExpired` needs nothing: balance reads already expire buckets by clock.

**1. Check for stuck rows** (read-only):

```sql
select transaction_type, status, count(*) from loyalty_transactions group by 1, 2;
select status, count(*) from operations group by 1;
select status, count(*) from voucher_ownerships group by 1;
```

If nothing is `PENDING`, `UNKNOWN` or `RESERVED`, or it is only test data, go to step 2. Otherwise,
note those rows first: the pruned events can't be replayed, so fix each one by hand from its
transaction digest on-chain (an explorer or `sui client tx-block <digest>`), after step 2.

**2. Reset the cursor to null**, which reads on from the oldest checkpoint the node still has.
Only the pruned gap is skipped. Replaying the rest is harmless (see **Dedup**):

```sql
-- An upsert, so it also works when the row is already gone.
insert into indexer_cursors (stream_name, cursor) values ('octap::credit_account', null)
on conflict (stream_name) do update set cursor = null;
```

No restart is needed; the next poll picks it up. It is healthy when the error stops, the row stays
in place with `cursor` null until the first new event, and `caught_up_checkpoint` starts rising.
Prefer this to `RESUME_AT_HEAD`, which also skips events the node still holds.

### Alternative: wipe and reseed a demo deployment

A demo deployment holds no data worth keeping, so instead of step 1 and step 2 it may be wiped and
seeded again by hand. Wipe for a testnet reset or a newly published package too, since every
object the old database points at is gone. Never wipe a database whose data must be kept.

What a wipe costs: every organization, member, API key, voucher and transaction in Postgres. The
chain keeps its `CreditAccount`s, balances and vouchers, but nothing maps them to members any
more. The indexer skips events for accounts this database did not open, and customers get new
accounts when they sign in again. Plan it before a demo, not during one.

1. Stop the API and the worker.
2. Recreate the database, connected to another database such as `postgres`:
   ```sql
   drop database octap_dev with (force);
   create database octap_dev;
   ```
   Use the name from `DATABASE_URL`.
3. Apply the schema: `npm run db:migrate`.
4. Start the API, and create the first System Admin with a fresh Google ID token:
   `scripts/console-operator.mjs --action bootstrap-admin` (see `docs/console-google-login.md`,
   "Operator commands and audit"; never pass the token as an argument).
5. The Owner signs in to the Console and applies for the organization; the System Admin approves it.
6. Provision it on-chain and issue its admin key (`docs/console-google-login.md`, "After
   organization approval"):
   ```text
   node --env-file=.env scripts/provision-program.mjs ORGANIZATION_UUID EARN_BPS EXPIRY_DAYS TOTAL_BUDGET SHARD_COUNT
   node --env-file=.env scripts/seed-dev-credential.mjs ORGANIZATION_UUID CREDENTIAL_NAME
   ```
   Provisioning spends gas from the program-admin and issuer signers, so fund them first.
7. Start the worker. With no `loyalty_transactions` and no cursor row, it starts at the stream
   head on its own.
8. Recreate the demo data through the product: the Owner creates vouchers in the Console, and
   customers sign in again to become members.
