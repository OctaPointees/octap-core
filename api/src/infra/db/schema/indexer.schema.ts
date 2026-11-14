import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * INDEXER CURSOR: resume point for one Sui event stream (`domain/indexer`). Global, not
 * tenant-scoped — one chain stream covers every organization — so no RLS policy.
 */
export const indexerCursors = pgTable('indexer_cursors', {
  id: uuid('id').defaultRandom().primaryKey(),
  streamName: text('stream_name').notNull().unique(),
  /** Opaque `listEvents` cursor; null means "read this stream from its very first event". */
  cursor: text('cursor'),
  /** Checkpoint of the newest event projected so far — what balance reads report as `asOfCheckpoint`. */
  lastCheckpoint: text('last_checkpoint'),
  /**
   * The stream has no unprojected event at or below this checkpoint: a poll after `cursor` came back
   * empty while the chain was at least this far. Only grows. Lets the indexer prove that a pruned
   * cursor lost nothing (see the `domain/indexer` README, "Pruned cursor").
   */
  caughtUpCheckpoint: text('caught_up_checkpoint'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
