import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { indexerCursors } from '../schema/indexer.schema.js';

/** The one stream `domain/indexer` projects today: every event `octap::credit_account` emits. */
export const CREDIT_ACCOUNT_STREAM = 'octap::credit_account';

/** Thrown by `commitPage` and `replaceCursor` when another indexer instance moved the cursor first. */
export class IndexerCursorMovedError extends Error {
  constructor(streamName: string) {
    super(`Cursor for "${streamName}" moved underneath this page; another indexer instance committed it first`);
    this.name = 'IndexerCursorMovedError';
  }
}

/** The row still holds `expected`: the guard every cursor write uses, so a second instance loses cleanly. */
function cursorIs(streamName: string, expected: string | null): SQL | undefined {
  return and(
    eq(indexerCursors.streamName, streamName),
    expected === null ? isNull(indexerCursors.cursor) : eq(indexerCursors.cursor, expected),
  );
}

/** `caught_up_checkpoint` only grows: never lower it when a slower poll lands after a faster one. */
function raiseCaughtUp(checkpoint: bigint) {
  return sql`greatest(coalesce(${indexerCursors.caughtUpCheckpoint}::numeric, 0), ${checkpoint.toString()}::numeric)::text`;
}

@Injectable()
export class IndexerRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  async getCursor(streamName: string) {
    return this.db.query.indexerCursors.findFirst({ where: eq(indexerCursors.streamName, streamName) });
  }

  /**
   * Creates the stream's cursor row on first run. `onConflictDoNothing` + re-read so two
   * instances bootstrapping at once both end up on whichever row won, instead of one failing.
   */
  async initCursor(
    streamName: string,
    cursor: string | null,
    lastCheckpoint: string | null,
    caughtUpCheckpoint: bigint | null = null,
  ) {
    await this.db
      .insert(indexerCursors)
      .values({ streamName, cursor, lastCheckpoint, caughtUpCheckpoint: caughtUpCheckpoint?.toString() ?? null })
      .onConflictDoNothing();
    const row = await this.getCursor(streamName);
    if (!row) {
      throw new Error(`Cursor row for "${streamName}" missing right after insert`);
    }
    return row;
  }

  /**
   * Moves the cursor somewhere no page led to: resuming a pruned cursor from the node's oldest
   * checkpoint, or the hand-written resume-at-head sentinel. One conditional update, so the row is
   * never missing in between (a missing row next to loyalty data makes the next poll refuse).
   */
  async replaceCursor(
    streamName: string,
    change: { expectedCursor: string | null; cursor: string | null; lastCheckpoint?: string | null },
  ) {
    const [moved] = await this.db
      .update(indexerCursors)
      .set({
        cursor: change.cursor,
        ...(change.lastCheckpoint !== undefined ? { lastCheckpoint: change.lastCheckpoint } : {}),
        updatedAt: new Date(),
      })
      .where(cursorIs(streamName, change.expectedCursor))
      .returning({ id: indexerCursors.id });
    if (!moved) {
      throw new IndexerCursorMovedError(streamName);
    }
  }

  /**
   * Records that a poll after `expectedCursor` found nothing up to `checkpoint`. A no-op when the
   * cursor has moved since: that instance's own poll records its own progress.
   */
  async markCaughtUp(streamName: string, expectedCursor: string | null, checkpoint: bigint) {
    await this.db
      .update(indexerCursors)
      .set({ caughtUpCheckpoint: raiseCaughtUp(checkpoint), updatedAt: new Date() })
      .where(cursorIs(streamName, expectedCursor));
  }

  /**
   * Runs `work` (the page's business writes, on the transaction handle it's given) and advances
   * the cursor in one transaction: either both commit or neither does, so a crash mid-page
   * replays the whole page from the previous cursor instead of skipping or double-applying it.
   * The update is conditional on the cursor still being `expectedCursor` — a second instance
   * that read the same page loses here and rolls its writes back, rather than racing this one.
   * `caughtUpCheckpoint` is set on the stream's last page, when nothing lies beyond it.
   */
  async commitPage<T>(
    streamName: string,
    page: {
      expectedCursor: string | null;
      nextCursor: string;
      lastCheckpoint: string | null;
      caughtUpCheckpoint?: bigint | null;
    },
    work: (tx: DrizzleDb) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      const result = await work(tx);

      const [advanced] = await tx
        .update(indexerCursors)
        .set({
          cursor: page.nextCursor,
          ...(page.lastCheckpoint !== null ? { lastCheckpoint: page.lastCheckpoint } : {}),
          ...(page.caughtUpCheckpoint != null ? { caughtUpCheckpoint: raiseCaughtUp(page.caughtUpCheckpoint) } : {}),
          updatedAt: new Date(),
        })
        .where(cursorIs(streamName, page.expectedCursor))
        .returning({ id: indexerCursors.id });
      if (!advanced) {
        throw new IndexerCursorMovedError(streamName);
      }

      return result;
    });
  }
}
