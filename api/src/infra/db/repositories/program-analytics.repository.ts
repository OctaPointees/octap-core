import { Inject, Injectable } from '@nestjs/common';
import { aliasedTable, and, count, eq, gte, inArray, lt, sql } from 'drizzle-orm';
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
  /** Reversals of an earn: points taken back. */
  reversedEarned: number;
  /** Reversals of a redemption: points given back. */
  reversedRedeemed: number;
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

/** The origin day buckets are aligned to, so every bucket starts at UTC midnight. */
const UTC_MIDNIGHT = '2000-01-01T00:00:00Z';

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
      // A REVERSAL row is unsigned: the transaction it reverses says which way the points moved.
      const original = aliasedTable(loyaltyTransactions, 'original');
      const reversals = await db
        .select({
          type: original.transactionType,
          total: sql<string>`coalesce(sum(${loyaltyTransactions.pointsAmount}), 0)`,
        })
        .from(loyaltyTransactions)
        .innerJoin(original, eq(original.id, loyaltyTransactions.reversesTransactionId))
        .where(and(where, eq(loyaltyTransactions.transactionType, 'REVERSAL')))
        .groupBy(original.transactionType);
      const reversed = Object.fromEntries(reversals.map((row) => [row.type, Number(row.total)]));
      const [{ activeMembers }] = await db
        .select({ activeMembers: sql<number>`count(distinct ${loyaltyTransactions.organizationEndUserId})::int` })
        .from(loyaltyTransactions)
        .where(and(where, inArray(loyaltyTransactions.transactionType, ['EARN', 'REDEEM'])));
      return {
        earned: sums.EARN ?? 0,
        redeemed: sums.REDEEM ?? 0,
        reversedEarned: reversed.EARN ?? 0,
        reversedRedeemed: reversed.REDEEM ?? 0,
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

  /**
   * Claimed in the window; redeemed/expired-unused are judged by their own timestamp, which may fall
   * outside it. Nothing marks a voucher EXPIRED when its time passes (expiry is read, not written), so
   * an unused one past `expiresAt` is still AVAILABLE: both count, up to now.
   */
  async voucherTotals(tx: DrizzleDb, organizationId: string, range: AnalyticsRange): Promise<VoucherTotals> {
    const expiredBefore = new Date(Math.min(range.to.getTime(), Date.now()));
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
            inArray(voucherOwnerships.status, ['AVAILABLE', 'EXPIRED']),
            gte(voucherOwnerships.expiresAt, range.from),
            lt(voucherOwnerships.expiresAt, expiredBefore),
          ),
        );
      return { claimed, redeemed, expiredUnused };
    });
  }

  /**
   * One row per UTC calendar day that `[range.from, range.to)` touches, empty days included — the
   * same `date_bin` + `generate_series` shape as `RequestLogsRepository.timeseries`. Days start at
   * UTC midnight whatever `from` is; the first and last only count what falls inside the window.
   */
  async dailyTrend(tx: DrizzleDb, organizationId: string, range: AnalyticsRange): Promise<DailyPoint[]> {
    return withTenant(tx, organizationId, async (db) => {
      const from = range.from.toISOString();
      const to = range.to.toISOString();
      const bucket = sql`date_bin('1 day'::interval, ${loyaltyTransactions.createdAt}, ${UTC_MIDNIGHT}::timestamptz)`;
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
        sql`select generate_series(date_bin('1 day'::interval, ${from}::timestamptz, ${UTC_MIDNIGHT}::timestamptz), ${to}::timestamptz - interval '1 microsecond', interval '1 day') as start`,
      );
      return starts.map(({ start }) => {
        const at = new Date(start);
        const row = byStart.get(at.getTime());
        return { start: at, earned: row ? Number(row.earned) : 0, redeemed: row ? Number(row.redeemed) : 0 };
      });
    });
  }
}
