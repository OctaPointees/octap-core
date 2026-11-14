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
  worth replaying in this demo. To replay from the beginning, set the row's `cursor` to null.
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

## Runbook: the stored cursor was pruned

**Symptom.** Every poll logs:

```
ERROR [CheckpointIndexerWorker] poll failed: requested data below earliest available; lowest available checkpoint is <N>
```

The fullnode keeps only recent checkpoints, and testnet prunes fast, so this shows up when the
worker was stopped for a few days. Restarting changes nothing: the worker resumes from the cursor
in `indexer_cursors`, which now points below checkpoint `<N>`.

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

**2. Reset the cursor to null**, which replays from the earliest checkpoint the node still has.
Only the pruned gap is skipped. Replaying the rest is harmless (see **Dedup**):

```sql
update indexer_cursors set cursor = null where stream_name = 'octap::credit_account';
```

No restart is needed; the next poll picks it up. It is healthy when the error stops and the row
stays in place with `cursor` null until the first new event, then a real cursor.

**Avoid `RESUME_AT_HEAD` here.** That sentinel deletes the row and then looks up the stream head
with a descending scan. When the package has no event inside the node's retained window, that scan
hits the same pruned-data error. The row is then gone, and the next poll refuses to start because
`loyalty_transactions` has rows. The worker is stuck until the row is put back, as in step 2.
Deleting the row yourself ends in the same refusal.
