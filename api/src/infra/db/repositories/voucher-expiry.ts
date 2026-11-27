import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import type { VoucherMemberExpiredEventData } from '@octap/contracts';
import type { DrizzleDb } from '../postgres.provider.js';
import { vouchers, voucherOwnerships } from '../schema/rewards.schema.js';
import { recordEvent } from './events.repository.js';
import { recordVoucherEvent } from './voucher-events.js';

/**
 * The statuses a closed claim window turns into `EXPIRED`. A `DRAFT` or `PENDING_APPROVAL` voucher
 * keeps its status: it can't go live past its expiry anyway, and whoever owns it fixes or drops it.
 */
const EXPIRABLE_VOUCHER_STATUSES: ('ACTIVE' | 'PAUSED' | 'DEPLETED')[] = ['ACTIVE', 'PAUSED', 'DEPLETED'];

/**
 * What one call may expire. Each kind defaults to every due row (the sweep). A read narrows it to
 * what it returns, so it never pays for an organization's whole backlog: the sweep keeps that.
 */
export interface ExpiryScope {
  /** Only this organization's rows. Without it, every organization's (the worker, outside RLS). */
  organizationId?: string;
  /** Which vouchers: every due one, only these ids, or none. */
  vouchers?: 'all' | 'none' | { ids: string[] };
  /** Which customers' vouchers: every due one, one member's, one voucher, or none. */
  memberVouchers?: 'all' | 'none' | { memberId: string } | { ownershipId: string };
}

export interface ExpiredVouchers {
  /** Vouchers whose claim window closed. */
  vouchers: number;
  /** Customers' vouchers that reached their own deadline unused. */
  memberVouchers: number;
}

/**
 * Writes `EXPIRED` on what is past its deadline, at most `limit` rows of each kind, and records one
 * event per row in the same transaction (`voucher.expired`, `voucher.member_expired`).
 *
 * `expires_at` is the truth and this status follows it. Only this function writes it, from the expiry
 * sweep and before a read. The use and claim checks still compare times, and so does the chain.
 * - A customer's voucher expires only from `AVAILABLE`. One that is `RESERVED` is in a use or a claim
 *   that the chain decides: if it comes back `AVAILABLE`, the next run expires it.
 * - Rows another transaction holds are skipped (`SKIP LOCKED`), never waited for, so this never
 *   blocks a use or a claim and never deadlocks with one. It picks them up on the next run.
 * - The update repeats the status condition, so two runs at once write each row and its event once.
 *
 * `options` says which rows it may touch (`ExpiryScope`).
 */
export async function expireDueVouchers(
  tx: DrizzleDb,
  options: ExpiryScope & { limit: number; now?: Date },
): Promise<ExpiredVouchers> {
  const now = options.now ?? new Date();
  const ofOrganization = options.organizationId ? eq(vouchers.organizationId, options.organizationId) : undefined;
  const voucherScope = options.vouchers ?? 'all';
  const ownershipScope = options.memberVouchers ?? 'all';
  const whichOwnerships =
    typeof ownershipScope !== 'object'
      ? undefined
      : 'memberId' in ownershipScope
        ? eq(voucherOwnerships.organizationEndUserId, ownershipScope.memberId)
        : eq(voucherOwnerships.id, ownershipScope.ownershipId);
  const whichVouchers = typeof voucherScope === 'object' ? inArray(vouchers.id, voucherScope.ids) : undefined;
  const noVouchers = voucherScope === 'none' || (typeof voucherScope === 'object' && voucherScope.ids.length === 0);

  const dueOwnerships =
    ownershipScope === 'none'
      ? []
      : await tx
          .select({ id: voucherOwnerships.id, organizationId: vouchers.organizationId })
          .from(voucherOwnerships)
          .innerJoin(vouchers, eq(vouchers.id, voucherOwnerships.voucherId))
          .where(
            and(
              eq(voucherOwnerships.status, 'AVAILABLE'),
              lte(voucherOwnerships.expiresAt, now),
              ofOrganization,
              whichOwnerships,
            ),
          )
          .orderBy(asc(voucherOwnerships.expiresAt))
          .limit(options.limit)
          .for('update', { of: voucherOwnerships, skipLocked: true });
  const organizationOf = new Map(dueOwnerships.map((row) => [row.id, row.organizationId]));
  const expiredOwnerships =
    dueOwnerships.length === 0
      ? []
      : await tx
          .update(voucherOwnerships)
          .set({ status: 'EXPIRED', updatedAt: now })
          .where(
            and(inArray(voucherOwnerships.id, [...organizationOf.keys()]), eq(voucherOwnerships.status, 'AVAILABLE')),
          )
          .returning();
  for (const ownership of expiredOwnerships) {
    const payload: VoucherMemberExpiredEventData = {
      voucherOwnershipId: ownership.id,
      voucherId: ownership.voucherId,
      organizationEndUserId: ownership.organizationEndUserId,
      serialCode: ownership.serialCode,
      status: ownership.status,
      expiresAt: ownership.expiresAt?.toISOString() ?? null,
    };
    await recordEvent(tx, {
      organizationId: organizationOf.get(ownership.id)!,
      type: 'voucher.member_expired',
      payload,
    });
  }

  const dueVouchers = noVouchers
    ? []
    : await tx
        .select({ id: vouchers.id })
        .from(vouchers)
        .where(
          and(
            inArray(vouchers.status, EXPIRABLE_VOUCHER_STATUSES),
            lte(vouchers.expiresAt, now),
            ofOrganization,
            whichVouchers,
          ),
        )
        .orderBy(asc(vouchers.expiresAt))
        .limit(options.limit)
        .for('update', { skipLocked: true });
  const expiredVouchers =
    dueVouchers.length === 0
      ? []
      : await tx
          .update(vouchers)
          .set({ status: 'EXPIRED', updatedAt: now })
          .where(
            and(
              inArray(
                vouchers.id,
                dueVouchers.map((row) => row.id),
              ),
              inArray(vouchers.status, EXPIRABLE_VOUCHER_STATUSES),
            ),
          )
          .returning();
  for (const voucher of expiredVouchers) await recordVoucherEvent(tx, 'voucher.expired', voucher);

  return { vouchers: expiredVouchers.length, memberVouchers: expiredOwnerships.length };
}
