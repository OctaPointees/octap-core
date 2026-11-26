import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { loyaltyTransactions } from '../schema/credits.schema.js';
import { organizationEndUsers } from '../schema/members.schema.js';
import { vouchers, voucherOwnerships } from '../schema/rewards.schema.js';
import { withTenant } from '../rls.js';

export interface AnalyticsRange {
  from: Date;
  to: Date;
}

export interface AnalyticsTotals {
  earned: number;
  redeemed: number;
  reversed: number;
  activeMembers: number;
}

export interface VoucherTotals {
  claimed: number;
  redeemed: number;
  expiredUnused: number;
}

export interface DailyPoint {
  start: Date;
  earned: number;
  redeemed: number;
}

const CONFIRMED_IN_RANGE = (organizationId: string, range: AnalyticsRange) =>
  and(
    eq(loyaltyTransactions.organizationId, organizationId),
    eq(loyaltyTransactions.status, 'CONFIRMED'),
    gte(loyaltyTransactions.createdAt, range.from),
    lt(loyaltyTransactions.createdAt, range.to),
  );

/**
 * The read side behind `ProgramAnalyticsSummary`: everything here is CONFIRMED-only, so a PENDING
 * earn (still waiting on the chain) never moves a number before OctaP has actually agreed to it.
 */
@Injectable()
export class ProgramAnalyticsRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  /** Sums by transaction type, plus how many distinct members earned or redeemed, in the window. */
  async totals(tx: DrizzleDb, organizationId: string, range: AnalyticsRange): Promise<AnalyticsTotals> {
    return withTenant(tx, organizationId, async (db) => {
      const where = CONFIRMED_IN_RANGE(organizationId, range);
      const byType = await db
        .select({
          type: loyaltyTransactions.transactionType,
          total: sql<string>`coalesce(sum(${loyaltyTransactions.pointsAmount}), 0)`,
        })
        .from(loyaltyTransactions)
        .where(where)
        .groupBy(loyaltyTransactions.transactionType);
      const sums = Object.fromEntries(byType.map((row) => [row.type, Number(row.total)]));
      const [{ activeMembers }] = await db
        .select({ activeMembers: sql<number>`count(distinct ${loyaltyTransactions.organizationEndUserId})::int` })
        .from(loyaltyTransactions)
        .where(and(where, inArray(loyaltyTransactions.transactionType, ['EARN', 'REDEEM'])));
      return {
        earned: sums.EARN ?? 0,
        redeemed: sums.REDEEM ?? 0,
        reversed: sums.REVERSAL ?? 0,
        activeMembers,
      };
    });
  }

  /** Everyone ever enrolled, regardless of the window — the base `activeMembers` is measured against. */
  async enrolledMembers(tx: DrizzleDb, organizationId: string): Promise<number> {
    return withTenant(tx, organizationId, async (db) => {
      const [{ total }] = await db
        .select({ total: count() })
        .from(organizationEndUsers)
        .where(eq(organizationEndUsers.organizationId, organizationId));
      return total;
    });
  }

  /** Claimed in the window; redeemed/expired-unused are judged by their own timestamp, which may fall outside it. */
  async voucherTotals(tx: DrizzleDb, organizationId: string, range: AnalyticsRange): Promise<VoucherTotals> {
    return withTenant(tx, organizationId, async (db) => {
      const [{ claimed }] = await db
        .select({ claimed: count() })
        .from(voucherOwnerships)
        .innerJoin(vouchers, eq(vouchers.id, voucherOwnerships.voucherId))
        .where(
          and(
            eq(vouchers.organizationId, organizationId),
            gte(voucherOwnerships.claimedAt, range.from),
            lt(voucherOwnerships.claimedAt, range.to),
          ),
        );
      const [{ redeemed }] = await db
        .select({ redeemed: count() })
        .from(voucherOwnerships)
        .innerJoin(vouchers, eq(vouchers.id, voucherOwnerships.voucherId))
        .where(
          and(
            eq(vouchers.organizationId, organizationId),
            eq(voucherOwnerships.status, 'REDEEMED'),
            gte(voucherOwnerships.redeemedAt, range.from),
            lt(voucherOwnerships.redeemedAt, range.to),
          ),
        );
      const [{ expiredUnused }] = await db
        .select({ expiredUnused: count() })
        .from(voucherOwnerships)
        .innerJoin(vouchers, eq(vouchers.id, voucherOwnerships.voucherId))
        .where(
          and(
            eq(vouchers.organizationId, organizationId),
            eq(voucherOwnerships.status, 'EXPIRED'),
            gte(voucherOwnerships.expiresAt, range.from),
            lt(voucherOwnerships.expiresAt, range.to),
          ),
        );
      return { claimed, redeemed, expiredUnused };
    });
  }

  /**
   * One row per calendar day in `[range.from, range.to)`, empty days included — the same
   * `date_bin` + `generate_series` shape as `RequestLogsRepository.timeseries`.
   */
  async dailyTrend(tx: DrizzleDb, organizationId: string, range: AnalyticsRange): Promise<DailyPoint[]> {
    return withTenant(tx, organizationId, async (db) => {
      const from = range.from.toISOString();
      const to = range.to.toISOString();
      const bucket = sql`date_bin('1 day'::interval, ${loyaltyTransactions.createdAt}, ${from}::timestamptz)`;
      const rows = await db
        .select({
          start: bucket.as('start'),
          earned: sql<string>`coalesce(sum(${loyaltyTransactions.pointsAmount}) filter (where ${loyaltyTransactions.transactionType} = 'EARN'), 0)`,
          redeemed: sql<string>`coalesce(sum(${loyaltyTransactions.pointsAmount}) filter (where ${loyaltyTransactions.transactionType} = 'REDEEM'), 0)`,
        })
        .from(loyaltyTransactions)
        .where(CONFIRMED_IN_RANGE(organizationId, range))
        .groupBy(sql`1`);
      const byStart = new Map(rows.map((row) => [new Date(row.start as unknown as string).getTime(), row]));
      const starts = await db.execute<{ start: Date | string }>(
        sql`select generate_series(${from}::timestamptz, ${to}::timestamptz - interval '1 microsecond', interval '1 day') as start`,
      );
      return starts.map(({ start }) => {
        const at = new Date(start);
        const row = byStart.get(at.getTime());
        return { start: at, earned: row ? Number(row.earned) : 0, redeemed: row ? Number(row.redeemed) : 0 };
      });
    });
  }
}
