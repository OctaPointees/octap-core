import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { operations } from '../schema/operations.schema.js';

/**
 * Minimal slice of the "operations" durable-command concern needed to dispatch an already-
 * accepted command to Sui. `domain/operations` (dedup, outbox replay, UNKNOWN recovery) in
 * docs/roadmap.md is the full feature; this repository only claims/resolves rows that
 * `CreditsRepository` already enqueued inside the same transaction as their PG command write.
 */
@Injectable()
export class OperationsRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  /**
   * Claims up to `limit` PENDING rows of the given command types by flipping them to PROCESSING
   * one at a time with a conditional update, so two worker instances racing on the same row only
   * ever have one succeed. (A single `UPDATE ... RETURNING` with `SKIP LOCKED` would claim a
   * batch in one round-trip instead of N+1; fine for today's single-worker demo, worth revisiting
   * before running more than one worker instance.)
   */
  async claimNextPending(commandTypes: string[], limit = 5) {
    const candidates = await this.db.query.operations.findMany({
      where: and(eq(operations.status, 'PENDING'), inArray(operations.commandType, commandTypes)),
      orderBy: [asc(operations.createdAt)],
      limit,
    });

    const claimed: (typeof operations.$inferSelect)[] = [];
    for (const candidate of candidates) {
      const [row] = await this.db
        .update(operations)
        .set({ status: 'PROCESSING', updatedAt: new Date() })
        .where(and(eq(operations.id, candidate.id), eq(operations.status, 'PENDING')))
        .returning();
      if (row) {
        claimed.push(row);
      }
    }
    return claimed;
  }

  async markSubmitted(id: string, suiTxDigest: string) {
    await this.db
      .update(operations)
      .set({ status: 'SUBMITTED', suiTxDigest, updatedAt: new Date() })
      .where(eq(operations.id, id));
  }

  async markFailed(id: string, errorMessage: string) {
    await this.db
      .update(operations)
      .set({ status: 'FAILED', errorMessage, updatedAt: new Date() })
      .where(eq(operations.id, id));
  }
}
