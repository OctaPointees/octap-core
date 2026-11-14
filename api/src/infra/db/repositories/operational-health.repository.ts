import { Inject, Injectable } from '@nestjs/common';
import { inArray, sql } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { operations } from '../schema/operations.schema.js';
import { webhookDeliveries } from '../schema/webhooks.schema.js';
import { indexerCursors } from '../schema/indexer.schema.js';

/** Operation statuses a worker still owes something to: not yet SUBMITTED or FAILED. */
export const UNSETTLED_OPERATION_STATUSES = ['PENDING', 'PROCESSING', 'UNKNOWN'] as const;

/** Seconds since `column`, measured by the database clock so app-server clock skew cannot distort it. */
const ageSeconds = (column: unknown) => sql<number>`floor(extract(epoch from (now() - ${column})))::int`;

/**
 * Cross-tenant, read-only aggregates for `observability`'s health report. Deliberately outside
 * `withRls`: it counts every organization's queue, the same way the workers that drain it do, and
 * returns only counts and ages — never a row's tenant, payload or id.
 */
@Injectable()
export class OperationalHealthRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  async ping(): Promise<void> {
    await this.db.execute(sql`select 1`);
  }

  /** Unsettled `operations` (the command outbox) per command type and status, oldest first by age. */
  async unsettledOperations() {
    return this.db
      .select({
        commandType: operations.commandType,
        status: operations.status,
        count: sql<number>`count(*)::int`,
        oldestAgeSeconds: ageSeconds(sql`min(${operations.createdAt})`),
      })
      .from(operations)
      .where(inArray(operations.status, [...UNSETTLED_OPERATION_STATUSES]))
      .groupBy(operations.commandType, operations.status)
      .orderBy(sql`min(${operations.createdAt})`);
  }

  /**
   * Webhook deliveries still owed (PENDING), how many of those are due now, how long the oldest due
   * one has waited past its `nextAttemptAt` (one backing off until later is not lag), and how many
   * are dead-lettered: no longer retried, waiting on a manual replay.
   */
  async webhookBacklog() {
    const isPending = sql`${webhookDeliveries.status} = 'PENDING'`;
    const isDue = sql`${isPending} and ${webhookDeliveries.nextAttemptAt} <= now()`;
    const [row] = await this.db
      .select({
        pending: sql<number>`(count(*) filter (where ${isPending}))::int`,
        due: sql<number>`(count(*) filter (where ${isDue}))::int`,
        oldestDueAgeSeconds: sql<
          number | null
        >`floor(extract(epoch from (now() - min(${webhookDeliveries.nextAttemptAt}) filter (where ${isDue}))))::int`,
        deadLettered: sql<number>`(count(*) filter (where ${webhookDeliveries.status} = 'DEAD_LETTER'))::int`,
      })
      .from(webhookDeliveries)
      .where(inArray(webhookDeliveries.status, ['PENDING', 'DEAD_LETTER']));
    return row;
  }

  /** Every indexer stream's progress and how long since the indexer last moved its cursor row. */
  async indexerStreams() {
    return this.db
      .select({
        streamName: indexerCursors.streamName,
        lastCheckpoint: indexerCursors.lastCheckpoint,
        caughtUpCheckpoint: indexerCursors.caughtUpCheckpoint,
        sinceUpdateSeconds: ageSeconds(indexerCursors.updatedAt),
      })
      .from(indexerCursors)
      .orderBy(indexerCursors.streamName);
  }
}
