# Indexer domain

Projects Sui's own record of what happened onto PostgreSQL, independent of whether the
synchronous path (chain-submit worker, POS finalize) ever got to record it — the automated version
of "an UNKNOWN operation stays UNKNOWN until someone checks the chain by hand" (OCT-43).

- `checkpoint-indexer.worker.ts` / `.processor.ts`: polls `octap::credit_account` events through
  `SuiTransactionBuilderClient.listCreditAccountEvents` (gRPC `core.listEvents`, read-only, no
  signer). For each `CreditEarned` (matched by `operation_key` = the command's idempotency key) or
  `CreditRedeemed` (matched by `reference` = the loyalty transaction id) whose loyalty transaction
  is still PENDING, it calls the same `confirmEarnOnChain`/`confirmPosRedemptionOnChain` the
  synchronous paths use, and moves the operation to SUBMITTED. A `CreditEarned` for an
  already-CONFIRMED earn backfills its expiry bucket if it has none (OCT-49). `CreditExpired`
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
