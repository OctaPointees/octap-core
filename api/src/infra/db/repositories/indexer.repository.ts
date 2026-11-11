import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { indexerCursors } from '../schema/indexer.schema.js';

/** The one stream `domain/indexer` projects today: every event `octap::credit_account` emits. */
export const CREDIT_ACCOUNT_STREAM = 'octap::credit_account';

/** Thrown by `commitPage` when another indexer instance advanced the cursor first. */
export class IndexerCursorMovedError extends Error {
  constructor(streamName: string) {
    super(`Cursor for "${streamName}" moved underneath this page; another indexer instance committed it first`);
    this.name = 'IndexerCursorMovedError';
  }
}

@Injectable()
export class IndexerRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  async getCursor(streamName: string) {
    return this.db.query.indexerCursors.findFirst({ where: eq(indexerCursors.streamName, streamName) });
  }

  /** Clears a stream's cursor row so the next `getCursor` reads it as a genuinely fresh stream. */
  async deleteCursor(streamName: string) {
    await this.db.delete(indexerCursors).where(eq(indexerCursors.streamName, streamName));
  }

  /**
   * Creates the stream's cursor row on first run. `onConflictDoNothing` + re-read so two
   * instances bootstrapping at once both end up on whichever row won, instead of one failing.
   */
  async initCursor(streamName: string, cursor: string | null, lastCheckpoint: string | null) {
    await this.db.insert(indexerCursors).values({ streamName, cursor, lastCheckpoint }).onConflictDoNothing();
    const row = await this.getCursor(streamName);
    if (!row) {
      throw new Error(`Cursor row for "${streamName}" missing right after insert`);
    }
    return row;
  }

  /**
   * Runs `work` (the page's business writes, on the transaction handle it's given) and advances
   * the cursor in one transaction: either both commit or neither does, so a crash mid-page
   * replays the whole page from the previous cursor instead of skipping or double-applying it.
   * The update is conditional on the cursor still being `expectedCursor` — a second instance
   * that read the same page loses here and rolls its writes back, rather than racing this one.
   */
  async commitPage<T>(
    streamName: string,
    page: { expectedCursor: string | null; nextCursor: string; lastCheckpoint: string | null },
    work: (tx: DrizzleDb) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      const result = await work(tx);

      const [advanced] = await tx
        .update(indexerCursors)
        .set({
          cursor: page.nextCursor,
          ...(page.lastCheckpoint !== null ? { lastCheckpoint: page.lastCheckpoint } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(indexerCursors.streamName, streamName),
            page.expectedCursor === null
              ? isNull(indexerCursors.cursor)
              : eq(indexerCursors.cursor, page.expectedCursor),
          ),
        )
        .returning({ id: indexerCursors.id });
      if (!advanced) {
        throw new IndexerCursorMovedError(streamName);
      }

      return result;
    });
  }
}
