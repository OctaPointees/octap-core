import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, gte, inArray, lt, lte, sql, type SQL } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { apiRequestLogs } from '../schema/request-logs.schema.js';
import { apiCredentials } from '../schema/organizations.schema.js';
import { withTenant } from '../rls.js';

export type ApiRequestLog = typeof apiRequestLogs.$inferSelect;
/** `createdAt` is when the request arrived, not when the row was written. */
export type NewApiRequestLog = Omit<typeof apiRequestLogs.$inferInsert, 'id' | 'sequence'> & { createdAt: Date };

/** Already validated by the caller (`RequestLogsService`). `status` is an inclusive status-code range. */
export interface RequestLogQuery {
  from: Date;
  to: Date;
  credentialId?: string;
  category?: string;
  method?: string;
  route?: string;
  status?: { min: number; max: number };
}

/** One log row with the key that made it: never the key itself. */
export type RequestLogRow = ApiRequestLog & { credentialName: string; credentialKeyPrefix: string };

/**
 * A position in the tail: the last row returned, by writing transaction and sequence, and when the
 * tail was opened (epoch ms). Only calls that arrived at or after `openedAt` are returned.
 */
export interface TailPosition {
  txId: number;
  sequence: number;
  openedAt: number;
}

export interface RawStats {
  requests: number;
  succeeded: number;
  clientErrors: number;
  serverErrors: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

/** Rate, errors and duration (RED) of whatever rows the query groups. */
const stats = {
  requests: sql<number>`count(*)::int`,
  succeeded: sql<number>`(count(*) filter (where ${apiRequestLogs.statusCode} < 400))::int`,
  clientErrors: sql<number>`(count(*) filter (where ${apiRequestLogs.statusCode} between 400 and 499))::int`,
  serverErrors: sql<number>`(count(*) filter (where ${apiRequestLogs.statusCode} >= 500))::int`,
  p50: sql<number | null>`percentile_disc(0.5) within group (order by ${apiRequestLogs.latencyMs})`,
  p95: sql<number | null>`percentile_disc(0.95) within group (order by ${apiRequestLogs.latencyMs})`,
  p99: sql<number | null>`percentile_disc(0.99) within group (order by ${apiRequestLogs.latencyMs})`,
};

const withCredential = {
  row: apiRequestLogs,
  credentialName: apiCredentials.name,
  credentialKeyPrefix: apiCredentials.keyPrefix,
};

function flatten(rows: { row: ApiRequestLog; credentialName: string; credentialKeyPrefix: string }[]): RequestLogRow[] {
  return rows.map(({ row, credentialName, credentialKeyPrefix }) => ({ ...row, credentialName, credentialKeyPrefix }));
}

/**
 * The request log (OCT-298). `record` and every read run under the organization's RLS context, so
 * Postgres itself hides other organizations' calls. `deleteExpired` is the one RLS exception: the
 * retention sweep trims every organization at once.
 */
@Injectable()
export class RequestLogsRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  async record(entry: NewApiRequestLog): Promise<void> {
    await withTenant(this.db, entry.organizationId, (tx) => tx.insert(apiRequestLogs).values(entry));
  }

  /** Newest first. `total` counts every row the filters match, for the pager. */
  async list(tx: DrizzleDb, organizationId: string, query: RequestLogQuery, page: number, limit: number) {
    return withTenant(tx, organizationId, async (db) => {
      const where = this.filters(organizationId, query);
      const [{ total }] = await db.select({ total: count() }).from(apiRequestLogs).where(where);
      const rows = await db
        .select(withCredential)
        .from(apiRequestLogs)
        .innerJoin(apiCredentials, eq(apiCredentials.id, apiRequestLogs.credentialId))
        .where(where)
        .orderBy(desc(apiRequestLogs.createdAt), desc(apiRequestLogs.sequence))
        .limit(limit)
        .offset((page - 1) * limit);
      return { rows: flatten(rows), total };
    });
  }

  async findByRequestId(tx: DrizzleDb, organizationId: string, requestId: string): Promise<RequestLogRow | undefined> {
    return withTenant(tx, organizationId, async (db) => {
      const rows = await db
        .select(withCredential)
        .from(apiRequestLogs)
        .innerJoin(apiCredentials, eq(apiCredentials.id, apiRequestLogs.credentialId))
        .where(and(eq(apiRequestLogs.organizationId, organizationId), eq(apiRequestLogs.requestId, requestId)));
      return flatten(rows)[0];
    });
  }

  /**
   * Where a new tail starts: just below the oldest transaction still running, so every row written
   * by a transaction that has not finished yet will still come. Rows at or above that `xmin` can
   * also include calls that had already finished before the tail opened (they committed while an
   * older transaction was still open), so the position also carries `openedAt`: a call that arrived
   * before it is history, not live, and `since` leaves it out.
   */
  async tailStart(tx: DrizzleDb, organizationId: string, openedAt: number): Promise<TailPosition> {
    return withTenant(tx, organizationId, async (db) => ({
      txId: (await this.settledBelow(db)) - 1,
      sequence: Number.MAX_SAFE_INTEGER,
      openedAt,
    }));
  }

  /**
   * Rows after `after`, in (`tx_id`, `sequence`) order, and only from transactions below the
   * snapshot's `xmin`: every such transaction has ended, so no row can later appear behind the
   * returned cursor. A row committing late (its insert waited on a lock) is returned once its
   * transaction ends, never skipped. A long-running transaction elsewhere delays the tail; it does
   * not lose rows.
   */
  async since(
    tx: DrizzleDb,
    organizationId: string,
    after: TailPosition,
    query: Omit<RequestLogQuery, 'from' | 'to'>,
    limit: number,
  ): Promise<RequestLogRow[]> {
    return withTenant(tx, organizationId, async (db) => {
      const settled = await this.settledBelow(db);
      const rows = await db
        .select(withCredential)
        .from(apiRequestLogs)
        .innerJoin(apiCredentials, eq(apiCredentials.id, apiRequestLogs.credentialId))
        .where(
          and(
            this.filters(organizationId, query),
            sql`(${apiRequestLogs.txId}, ${apiRequestLogs.sequence}) > (${after.txId}, ${after.sequence})`,
            lt(apiRequestLogs.txId, settled),
            gte(apiRequestLogs.createdAt, new Date(after.openedAt)),
          ),
        )
        .orderBy(asc(apiRequestLogs.txId), asc(apiRequestLogs.sequence))
        .limit(limit);
      return flatten(rows);
    });
  }

  /** The snapshot's `xmin`: every transaction with a lower id has committed or rolled back. */
  private async settledBelow(db: DrizzleDb): Promise<number> {
    const [row] = await db.execute<{ xmin: string }>(
      sql`select (pg_snapshot_xmin(pg_current_snapshot())::text) as xmin`,
    );
    return Number(row.xmin);
  }

  async summary(tx: DrizzleDb, organizationId: string, query: RequestLogQuery, topRoutes: number) {
    return withTenant(tx, organizationId, async (db) => {
      const where = this.filters(organizationId, query);
      const [totals] = await db.select(stats).from(apiRequestLogs).where(where);
      const byCategory = await db
        .select({ category: apiRequestLogs.category, ...stats })
        .from(apiRequestLogs)
        .where(where)
        .groupBy(apiRequestLogs.category)
        .orderBy(desc(sql`count(*)`), asc(apiRequestLogs.category));
      const byRoute = await db
        .select({ method: apiRequestLogs.method, route: apiRequestLogs.route, ...stats })
        .from(apiRequestLogs)
        .where(where)
        .groupBy(apiRequestLogs.method, apiRequestLogs.route)
        .orderBy(desc(sql`count(*)`), asc(apiRequestLogs.route), asc(apiRequestLogs.method))
        .limit(topRoutes);
      const perCredential = await db
        .select({ credentialId: apiRequestLogs.credentialId, ...stats })
        .from(apiRequestLogs)
        .where(where)
        .groupBy(apiRequestLogs.credentialId)
        .orderBy(desc(sql`count(*)`));
      const names = perCredential.length
        ? await db
            .select({ id: apiCredentials.id, name: apiCredentials.name, keyPrefix: apiCredentials.keyPrefix })
            .from(apiCredentials)
            .where(
              inArray(
                apiCredentials.id,
                perCredential.map((row) => row.credentialId),
              ),
            )
        : [];
      const byId = new Map(names.map((row) => [row.id, row]));
      const byCredential = perCredential.map(({ credentialId, ...rest }) => ({
        ...rest,
        credential: byId.get(credentialId) ?? { id: credentialId, name: '', keyPrefix: '' },
      }));
      return { totals, byCategory, byRoute, byCredential };
    });
  }

  /**
   * Every `intervalSeconds` bucket from `query.from` to `query.to`, empty ones included. Buckets are
   * aligned on `query.from`, so the first one starts exactly there.
   */
  async timeseries(tx: DrizzleDb, organizationId: string, query: RequestLogQuery, intervalSeconds: number) {
    return withTenant(tx, organizationId, async (db) => {
      const step = sql.raw(`'${intervalSeconds} seconds'::interval`);
      const from = query.from.toISOString();
      const to = query.to.toISOString();
      const bucket = sql`date_bin(${step}, ${apiRequestLogs.createdAt}, ${from}::timestamptz)`;
      const filled = await db
        .select({ start: bucket.as('start'), ...stats })
        .from(apiRequestLogs)
        .where(this.filters(organizationId, query))
        .groupBy(sql`1`);
      const counts = new Map(filled.map((row) => [new Date(row.start as unknown as string).getTime(), row]));
      const starts = await db.execute<{ start: Date | string }>(
        sql`select generate_series(${from}::timestamptz, ${to}::timestamptz - interval '1 microsecond', ${step}) as start`,
      );
      return starts.map(({ start }) => {
        const at = new Date(start);
        return { start: at, stats: counts.get(at.getTime()) };
      });
    });
  }

  /** Failed calls grouped by endpoint, status and error code, most frequent first. */
  async errorGroups(tx: DrizzleDb, organizationId: string, query: RequestLogQuery, limit: number) {
    return withTenant(tx, organizationId, (db) =>
      db
        .select({
          method: apiRequestLogs.method,
          route: apiRequestLogs.route,
          statusCode: apiRequestLogs.statusCode,
          errorCode: apiRequestLogs.errorCode,
          count: sql<number>`count(*)::int`,
          firstSeenAt: sql<Date>`min(${apiRequestLogs.createdAt})`,
          lastSeenAt: sql<Date>`max(${apiRequestLogs.createdAt})`,
          lastRequestId: sql<string>`(array_agg(${apiRequestLogs.requestId} order by ${apiRequestLogs.createdAt} desc, ${apiRequestLogs.sequence} desc))[1]`,
          errorMessage: sql<
            string | null
          >`(array_agg(${apiRequestLogs.errorMessage} order by ${apiRequestLogs.createdAt} desc, ${apiRequestLogs.sequence} desc))[1]`,
        })
        .from(apiRequestLogs)
        .where(and(this.filters(organizationId, query), gte(apiRequestLogs.statusCode, 400)))
        .groupBy(apiRequestLogs.method, apiRequestLogs.route, apiRequestLogs.statusCode, apiRequestLogs.errorCode)
        .orderBy(desc(sql`count(*)`), desc(sql`max(${apiRequestLogs.createdAt})`))
        .limit(limit),
    );
  }

  /** RLS exception (every organization): deletes up to `limit` rows older than `before`. */
  async deleteExpired(before: Date, limit: number): Promise<number> {
    const doomed = this.db
      .select({ id: apiRequestLogs.id })
      .from(apiRequestLogs)
      .where(lt(apiRequestLogs.createdAt, before))
      .limit(limit);
    const deleted = await this.db
      .delete(apiRequestLogs)
      .where(inArray(apiRequestLogs.id, doomed))
      .returning({ id: apiRequestLogs.id });
    return deleted.length;
  }

  private filters(organizationId: string, query: Partial<RequestLogQuery>): SQL | undefined {
    const conditions: (SQL | undefined)[] = [eq(apiRequestLogs.organizationId, organizationId)];
    if (query.from) conditions.push(gte(apiRequestLogs.createdAt, query.from));
    if (query.to) conditions.push(lt(apiRequestLogs.createdAt, query.to));
    if (query.credentialId) conditions.push(eq(apiRequestLogs.credentialId, query.credentialId));
    if (query.category) conditions.push(eq(apiRequestLogs.category, query.category));
    if (query.method) conditions.push(eq(apiRequestLogs.method, query.method));
    if (query.route) conditions.push(eq(apiRequestLogs.route, query.route));
    if (query.status) {
      conditions.push(gte(apiRequestLogs.statusCode, query.status.min));
      conditions.push(lte(apiRequestLogs.statusCode, query.status.max));
    }
    return and(...conditions);
  }
}
