import { Inject, Injectable } from '@nestjs/common';
import type { VoucherRefundPolicySnapshot } from '@octap/contracts';
import { eq, desc, and, asc, gt, lt, lte, ne, inArray, isNull, sql } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import {
  blockchainTransactions,
  creditBuckets,
  creditOwnerships,
  loyaltyTransactions,
} from '../schema/credits.schema.js';
import { operations } from '../schema/operations.schema.js';
import { vouchers, voucherOwnerships } from '../schema/rewards.schema.js';
import { acceptCommand } from './operations.repository.js';
import { enqueueWebhookEvent } from './webhooks.repository.js';
import { endUsers, organizationEndUsers } from '../schema/members.schema.js';
import { withRls } from '../rls.js';

/**
 * Row-locks a loyalty transaction and returns it if it is still PENDING (null otherwise). Every
 * chain-outcome writer (`confirm*OnChain`/`fail*OnChain`) calls this first, so the synchronous
 * path (chain-submit worker, POS finalize, `ChainOutcomeReconciler`) and `domain/indexer` can race
 * on the same row and exactly one resolves it; the loser sees a non-PENDING row and does nothing
 * instead of re-applying the balance effect or queueing a second confirmation webhook.
 */
async function lockPendingTransaction(tx: DrizzleDb, loyaltyTransactionId: string) {
  const [row] = await tx
    .select({ status: loyaltyTransactions.status, organizationId: loyaltyTransactions.organizationId })
    .from(loyaltyTransactions)
    .where(eq(loyaltyTransactions.id, loyaltyTransactionId))
    .for('update');
  return row?.status === 'PENDING' ? row : null;
}

/**
 * Row-locks a member's credit ownership. The confirm/fail writers compute absolute balances from
 * this snapshot, so it must be locked: two transactions for the same member resolving at once
 * (chain-submit worker confirming one while the indexer confirms another, or two POS reserves)
 * would otherwise both read the same row and one delta would be lost.
 */
async function lockOwnership(tx: DrizzleDb, organizationEndUserId: string) {
  const [row] = await tx
    .select()
    .from(creditOwnerships)
    .where(eq(creditOwnerships.organizationEndUserId, organizationEndUserId))
    .for('update');
  return row;
}

/**
 * Records the bucket an EARN created on-chain. No-op if it exists, so indexer replays can backfill.
 * Returns whether a bucket was inserted.
 */
async function insertEarnBucket(
  tx: DrizzleDb,
  params: { creditOwnershipId: string; earnTransactionId: string; amount: number; expiresAtMs: number },
): Promise<boolean> {
  const inserted = await tx
    .insert(creditBuckets)
    .values({ ...params, remaining: params.amount })
    .onConflictDoNothing({ target: creditBuckets.earnTransactionId })
    .returning({ id: creditBuckets.id });
  return inserted.length > 0;
}

/**
 * After a backfill, buckets must not hold more than the balance: points spent before the bucket
 * existed were never debited from it. Trims the excess nearest-expiry first (expired buckets
 * included), which is where FIFO spending would have taken it from, so the next expiry can't
 * forfeit points that belong to a later bucket.
 */
async function trimBucketsToBalance(tx: DrizzleDb, ownership: { id: string; confirmedBalance: unknown }) {
  const buckets = await tx
    .select()
    .from(creditBuckets)
    .where(and(eq(creditBuckets.creditOwnershipId, ownership.id), gt(creditBuckets.remaining, 0)))
    .orderBy(asc(creditBuckets.expiresAtMs))
    .for('update');

  let excess =
    buckets.reduce((sum, b) => sum + Number(b.remaining), 0) - Math.max(Number(ownership.confirmedBalance), 0);
  for (const bucket of buckets) {
    if (excess <= 0) {
      break;
    }
    const take = Math.min(excess, Number(bucket.remaining));
    await tx
      .update(creditBuckets)
      .set({ remaining: Number(bucket.remaining) - take })
      .where(eq(creditBuckets.id, bucket.id));
    excess -= take;
  }
}

/**
 * Debits `amount` from live buckets, nearest expiry first (same order as `redeem` on-chain). If
 * buckets run out, the rest came from points that have no bucket (see `creditBuckets`).
 */
async function consumeBuckets(tx: DrizzleDb, creditOwnershipId: string, amount: number, nowMs = Date.now()) {
  const live = await tx
    .select()
    .from(creditBuckets)
    .where(
      and(
        eq(creditBuckets.creditOwnershipId, creditOwnershipId),
        gt(creditBuckets.remaining, 0),
        gt(creditBuckets.expiresAtMs, nowMs),
      ),
    )
    .orderBy(asc(creditBuckets.expiresAtMs))
    .for('update');

  let left = amount;
  for (const bucket of live) {
    if (left <= 0) {
      break;
    }
    const take = Math.min(left, Number(bucket.remaining));
    await tx
      .update(creditBuckets)
      .set({ remaining: Number(bucket.remaining) - take })
      .where(eq(creditBuckets.id, bucket.id));
    left -= take;
  }
}

/**
 * Lazy expiry: forfeits every bucket of this member whose `expiresAtMs` has passed, takes it off
 * `confirmedBalance`, and records one EXPIRY transaction. Called before anything reads or spends
 * the balance, so a due bucket never counts even before the chain emits `CreditExpired` — no
 * periodic sweep job needed. Idempotent: forfeited buckets are zeroed under a row lock.
 *
 * The forfeit is capped at the current balance (never below zero): a bucket can outlive points
 * spent off-chain without a matching bucket debit (e.g. a voucher claim before buckets existed),
 * and expiry must not invent debt — only a reversal can create clawback debt.
 */
export async function expireDueBuckets(
  tx: DrizzleDb,
  member: { organizationId: string; organizationEndUserId: string },
  nowMs = Date.now(),
): Promise<number> {
  const ownership = await lockOwnership(tx, member.organizationEndUserId);
  if (!ownership) {
    return 0;
  }

  const due = await tx
    .select()
    .from(creditBuckets)
    .where(
      and(
        eq(creditBuckets.creditOwnershipId, ownership.id),
        gt(creditBuckets.remaining, 0),
        lte(creditBuckets.expiresAtMs, nowMs),
      ),
    )
    .orderBy(asc(creditBuckets.expiresAtMs))
    .for('update');
  if (due.length === 0) {
    return 0;
  }

  await tx
    .update(creditBuckets)
    .set({ remaining: 0 })
    .where(
      inArray(
        creditBuckets.id,
        due.map((b) => b.id),
      ),
    );

  const total = due.reduce((sum, b) => sum + Number(b.remaining), 0);
  const forfeited = Math.min(total, Math.max(Number(ownership.confirmedBalance), 0));
  if (forfeited > 0) {
    await tx
      .update(creditOwnerships)
      .set({ confirmedBalance: Number(ownership.confirmedBalance) - forfeited, updatedAt: new Date() })
      .where(eq(creditOwnerships.id, ownership.id));
    await tx.insert(loyaltyTransactions).values({
      organizationId: member.organizationId,
      organizationEndUserId: member.organizationEndUserId,
      transactionType: 'EXPIRY',
      pointsAmount: forfeited,
      // Each bucket is swept exactly once, so the earliest one names this sweep uniquely.
      idempotencyKey: `expiry:${due[0].id}`,
      status: 'CONFIRMED',
      metadata: { bucketIds: due.map((b) => b.id) },
    });
  }
  return forfeited;
}

/** Settle the reserved coupon in the same transaction as the point hold. Lock catalog before balance. */
async function settleVoucherClaim(tx: DrizzleDb, loyaltyTransactionId: string, confirmed: boolean) {
  const claim = await tx.query.voucherOwnerships.findFirst({
    where: eq(voucherOwnerships.loyaltyTransactionId, loyaltyTransactionId),
  });
  if (!claim || claim.status !== 'RESERVED') return;
  await tx.select({ id: vouchers.id }).from(vouchers).where(eq(vouchers.id, claim.voucherId)).for('update');
  const [changed] = await tx
    .update(voucherOwnerships)
    .set({ status: confirmed ? 'AVAILABLE' : 'CANCELLED', updatedAt: new Date() })
    .where(and(eq(voucherOwnerships.id, claim.id), eq(voucherOwnerships.status, 'RESERVED')))
    .returning();
  if (changed && !confirmed) await returnVoucherUnit(tx, claim.voucherId);
}

/** Puts a cancelled coupon's unit back in the catalog; the caller holds the voucher row lock. */
async function returnVoucherUnit(tx: DrizzleDb, voucherId: string) {
  await tx
    .update(vouchers)
    .set({
      claimedCount: sql`${vouchers.claimedCount} - 1`,
      status: sql`case when ${vouchers.status} = 'DEPLETED' then 'ACTIVE'::voucher_status else ${vouchers.status} end`,
      updatedAt: new Date(),
    })
    .where(eq(vouchers.id, voucherId));
}

/** Thrown by `recordReversalTransaction` for a voucher claim whose coupon can no longer be taken back. */
export class VoucherClaimNotReversibleError extends Error {
  constructor(couponStatus: string, reason: string) {
    super(
      `This voucher claim cannot be reversed: ${reason} (coupon status: ${couponStatus}). ` +
        'Check the coupon refund terms or issue separate compensation.',
    );
    this.name = 'VoucherClaimNotReversibleError';
  }
}

export interface VoucherRefundContext {
  status: string;
  claimedAt: Date;
  expiresAt: Date | null;
  refundPolicySnapshot: VoucherRefundPolicySnapshot;
}

/** Only allowed decisions carry a new coupon state and stock effect. */
export type VoucherRefundDecision =
  | { allowed: false; couponStatus: string; reason: string }
  | { allowed: true; nextStatus: 'CANCELLED' | 'REDEEMED' | 'EXPIRED'; restock: boolean; reason: string };

/** The durable command a POS reserve is accepted under (OCT-55). */
export const POS_RESERVE_COMMAND_TYPE = 'CREDIT_POS_REDEEM_RESERVE';

/**
 * A paid voucher claim's hold (OCT-231). Signed, finalized and settled exactly like a POS reserve,
 * but it also holds catalog stock, so `ChainOutcomeReconciler` releases it once it is abandoned
 * unsigned instead of waiting for the member's next balance read.
 */
export const VOUCHER_CLAIM_RESERVE_COMMAND_TYPE = 'VOUCHER_CLAIM_RESERVE';

const VOUCHER_CLAIM_REFERENCE_PREFIX = 'voucher-claim-';

/**
 * A paid claim's receipt reference, also passed as the on-chain `reference` of its
 * `credit_account::redeem`, so the indexer and `reverse_redeem` can find the claim from the chain.
 */
export const voucherClaimReference = (ownershipId: string) => `${VOUCHER_CLAIM_REFERENCE_PREFIX}${ownershipId}`;

/** The claim's ownership id, or null when `reference` is not a voucher claim's. */
export function parseVoucherClaimReference(reference: string | null | undefined): string | null {
  return reference?.startsWith(VOUCHER_CLAIM_REFERENCE_PREFIX)
    ? reference.slice(VOUCHER_CLAIM_REFERENCE_PREFIX.length)
    : null;
}

/** Every command whose hold settles through a customer-signed `credit_account::redeem`. */
export const CUSTOMER_REDEEM_COMMAND_TYPES = [POS_RESERVE_COMMAND_TYPE, VOUCHER_CLAIM_RESERVE_COMMAND_TYPE];

/**
 * How long a POS reserve that was never finalized keeps its points held before the member's next
 * reserve or balance read releases it. Deliberately longer than `PosRedemptionService`'s `RESERVE_TTL_SECONDS`
 * (the sponsored-bytes cache): by the time a hold is released, every digest sponsored for it has
 * left the cache, so no finalize can still land against it.
 */
export const ABANDONED_POS_HOLD_GRACE_MS = 30 * 60 * 1000;

/**
 * Lazy hold expiry (OCT-244), same lazy pattern as `expireDueBuckets`: releases this member's POS
 * reserves and paid voucher claims that were never finalized, so an abandoned reserve can't lock
 * points in `pendingRedemption` forever. Each is marked FAILED and its points return to the available
 * balance.
 *
 * Only a hold whose command is still PENDING **with no recorded finalize digest** qualifies: once
 * finalize has recorded a digest (OCT-52) its outcome belongs to `ChainOutcomeReconciler`, however
 * old it is. The command is claimed by one conditional `UPDATE`, which serializes against
 * `recordSubmitDigestForCommand` on the same row, so exactly one of "released" and "finalize
 * recorded a digest" wins.
 *
 * Age is the command's `updatedAt`, which `reservePosRedemption` refreshes on every retry under
 * the same key. `graceMs` must exceed the sponsored-bytes cache TTL: a hold is then released only
 * once no cached bytes for it can still be finalized.
 */
export async function releaseAbandonedPosHolds(
  tx: DrizzleDb,
  member: { organizationId: string; organizationEndUserId: string },
  graceMs: number,
  options: { nowMs?: number; exceptIdempotencyKey?: string } = {},
): Promise<number> {
  const nowMs = options.nowMs ?? Date.now();
  const abandoned = await tx
    .update(operations)
    .set({
      status: 'FAILED',
      errorMessage: 'POS reserve abandoned: never finalized within the hold grace period',
      updatedAt: new Date(nowMs),
    })
    .where(
      and(
        eq(operations.tenantId, member.organizationId),
        inArray(operations.commandType, CUSTOMER_REDEEM_COMMAND_TYPES),
        eq(operations.status, 'PENDING'),
        isNull(operations.suiTxDigest),
        lt(operations.updatedAt, new Date(nowMs - graceMs)),
        sql`${operations.payload} ->> 'organizationEndUserId' = ${member.organizationEndUserId}`,
        ...(options.exceptIdempotencyKey ? [ne(operations.idempotencyKey, options.exceptIdempotencyKey)] : []),
      ),
    )
    .returning({ idempotencyKey: operations.idempotencyKey });
  if (abandoned.length === 0) {
    return 0;
  }

  const released = await tx
    .update(loyaltyTransactions)
    .set({ status: 'FAILED', updatedAt: new Date(nowMs) })
    .where(
      and(
        eq(loyaltyTransactions.organizationId, member.organizationId),
        eq(loyaltyTransactions.organizationEndUserId, member.organizationEndUserId),
        eq(loyaltyTransactions.transactionType, 'REDEEM'),
        eq(loyaltyTransactions.status, 'PENDING'),
        inArray(
          loyaltyTransactions.idempotencyKey,
          abandoned.map((op) => op.idempotencyKey),
        ),
      ),
    )
    .returning({ id: loyaltyTransactions.id, pointsAmount: loyaltyTransactions.pointsAmount });
  // Voucher claims share this command pipeline: release their coupon/stock in the same transaction.
  for (const row of released) await settleVoucherClaim(tx, row.id, false);
  const total = released.reduce((sum, row) => sum + Number(row.pointsAmount), 0);
  if (total === 0) {
    return 0;
  }

  const ownership = await lockOwnership(tx, member.organizationEndUserId);
  if (ownership) {
    await tx
      .update(creditOwnerships)
      .set({ pendingRedemption: Number(ownership.pendingRedemption) - total, updatedAt: new Date(nowMs) })
      .where(eq(creditOwnerships.id, ownership.id));
  }
  return total;
}

@Injectable()
export class CreditsRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  /** Looks up which organization a member belongs to, for tenant-ownership checks. */
  async findMemberOrganizationId(organizationEndUserId: string): Promise<string | null> {
    const row = await this.db.query.organizationEndUsers.findFirst({
      where: eq(organizationEndUsers.id, organizationEndUserId),
      columns: { organizationId: true },
    });
    return row?.organizationId ?? null;
  }

  /**
   * The member's real zkLogin Sui address, via organization_end_users -> end_users. Always
   * populated by the time a member can earn or redeem at all: `organization_end_users` can only
   * be created by `IdentityService.enrollInOrganization`, which requires the end user to already
   * exist, which only happens via `loginWithGoogle` — there is no "enrolled but never logged in"
   * path in this codebase. A null here is a data integrity problem, not a normal pending state.
   */
  async findBeneficiaryAddress(organizationEndUserId: string): Promise<string | null> {
    const rows = await this.db
      .select({ suiAddress: endUsers.suiAddress })
      .from(organizationEndUsers)
      .innerJoin(endUsers, eq(organizationEndUsers.endUserId, endUsers.id))
      .where(eq(organizationEndUsers.id, organizationEndUserId))
      .limit(1);
    return rows[0]?.suiAddress ?? null;
  }

  async getOrCreateCreditOwnership(organizationEndUserId: string) {
    const existing = await this.db.query.creditOwnerships.findFirst({
      where: eq(creditOwnerships.organizationEndUserId, organizationEndUserId),
    });
    if (existing) {
      return existing;
    }

    const [created] = await this.db
      .insert(creditOwnerships)
      .values({
        organizationEndUserId,
        confirmedBalance: 0,
        pendingEarn: 0,
        pendingRedemption: 0,
        lifetimeEarned: 0,
        lifetimeRedeemed: 0,
      })
      .returning();

    return created;
  }

  async findTransactionByIdempotency(organizationId: string, idempotencyKey: string) {
    return this.db.query.loyaltyTransactions.findFirst({
      where: (t, { and, eq }) => and(eq(t.organizationId, organizationId), eq(t.idempotencyKey, idempotencyKey)),
    });
  }

  async findTransactionByIdForOrganization(organizationId: string, transactionId: string) {
    return this.db.query.loyaltyTransactions.findFirst({
      where: (t, { and, eq }) => and(eq(t.id, transactionId), eq(t.organizationId, organizationId)),
    });
  }

  /** Finds the REVERSAL row (if any) that already reverses the given transaction. */
  async findReversalOf(transactionId: string) {
    return this.db.query.loyaltyTransactions.findFirst({
      where: eq(loyaltyTransactions.reversesTransactionId, transactionId),
    });
  }

  /**
   * Durably accepts an earn command: inserts the loyalty transaction as PENDING, moves
   * `pointsAmount` into `pendingEarn` (not `confirmedBalance` — Sui is authoritative for
   * confirmed points, see docs/architecture.md), and enqueues a `CREDIT_EARN_CHAIN_SUBMIT`
   * operation in the same transaction so command acceptance and chain dispatch commit atomically.
   * `ChainSubmitProcessor` (domain/credits/chain-submit.processor.ts) resolves it later via
   * `confirmEarnOnChain`/`failEarnOnChain`.
   */
  async recordEarnTransaction(params: {
    organizationId: string;
    organizationEndUserId: string;
    pointsAmount: number;
    idempotencyKey: string;
    receiptReference?: string;
    metadata?: Record<string, unknown>;
  }) {
    return withRls(this.db, { tenantId: params.organizationId, role: 'authenticated' }, async (tx) => {
      let ownership = await tx.query.creditOwnerships.findFirst({
        where: eq(creditOwnerships.organizationEndUserId, params.organizationEndUserId),
      });

      if (!ownership) {
        const [newOwnership] = await tx
          .insert(creditOwnerships)
          .values({
            organizationEndUserId: params.organizationEndUserId,
            confirmedBalance: 0,
            pendingEarn: 0,
            pendingRedemption: 0,
            lifetimeEarned: 0,
            lifetimeRedeemed: 0,
          })
          .returning();
        ownership = newOwnership;
      }

      const [transaction] = await tx
        .insert(loyaltyTransactions)
        .values({
          organizationId: params.organizationId,
          organizationEndUserId: params.organizationEndUserId,
          transactionType: 'EARN',
          pointsAmount: params.pointsAmount,
          idempotencyKey: params.idempotencyKey,
          receiptReference: params.receiptReference,
          status: 'PENDING',
          metadata: params.metadata ?? {},
        })
        .returning();

      const newPendingEarn = Number(ownership.pendingEarn) + params.pointsAmount;
      await tx
        .update(creditOwnerships)
        .set({ pendingEarn: newPendingEarn, updatedAt: new Date() })
        .where(eq(creditOwnerships.id, ownership.id));

      await acceptCommand(tx, {
        tenantId: params.organizationId,
        idempotencyKey: params.idempotencyKey,
        commandType: 'CREDIT_EARN_CHAIN_SUBMIT',
        payload: {
          loyaltyTransactionId: transaction.id,
          organizationEndUserId: params.organizationEndUserId,
          pointsAmount: params.pointsAmount,
        },
      });

      return {
        transaction,
        // Unchanged until chain confirmation; see pendingEarn above for the in-flight amount.
        newBalance: Number(ownership.confirmedBalance),
      };
    });
  }

  async getLoyaltyTransactionById(id: string) {
    return this.db.query.loyaltyTransactions.findFirst({ where: eq(loyaltyTransactions.id, id) });
  }

  async getCreditOwnershipByEndUserId(organizationEndUserId: string) {
    return this.db.query.creditOwnerships.findFirst({
      where: eq(creditOwnerships.organizationEndUserId, organizationEndUserId),
    });
  }

  /** Maps an on-chain `CreditAccount` id (from an event's `account_id`) back to its member. */
  async findCreditOwnershipBySuiAccountId(suiCreditAccountId: string) {
    return this.db.query.creditOwnerships.findFirst({
      where: eq(creditOwnerships.suiCreditAccountId, suiCreditAccountId),
    });
  }

  /**
   * Idempotency keys are only unique per organization; scoping by member (which belongs to exactly
   * one organization) is at least as narrow, and is what a chain event identifies via its account.
   */
  async findTransactionByMemberAndIdempotency(organizationEndUserId: string, idempotencyKey: string) {
    return this.db.query.loyaltyTransactions.findFirst({
      where: and(
        eq(loyaltyTransactions.organizationEndUserId, organizationEndUserId),
        eq(loyaltyTransactions.idempotencyKey, idempotencyKey),
      ),
    });
  }

  /** `releaseAbandonedPosHolds` in its own transaction, for a balance read. */
  async releaseAbandonedPosHoldsForMember(member: {
    organizationId: string;
    organizationEndUserId: string;
  }): Promise<number> {
    return withRls(this.db, { tenantId: member.organizationId, role: 'authenticated' }, (tx) =>
      releaseAbandonedPosHolds(tx, member, ABANDONED_POS_HOLD_GRACE_MS),
    );
  }

  /** `expireDueBuckets` in its own transaction (or the caller's, as a savepoint, via `db`). */
  async expireDueBucketsForMember(
    member: { organizationId: string; organizationEndUserId: string },
    db: DrizzleDb = this.db,
  ): Promise<number> {
    return db.transaction(async (tx) => expireDueBuckets(tx, member));
  }

  /**
   * Indexer backfill: an EARN confirmed before buckets existed has none, so replaying its
   * `CreditEarned` creates it. A no-op for every earn confirmed since (bucket already there).
   */
  async ensureEarnBucket(
    params: { organizationEndUserId: string; earnTransactionId: string; amount: number; expiresAtMs: number },
    db: DrizzleDb = this.db,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      const ownership = await lockOwnership(tx, params.organizationEndUserId);
      if (!ownership) {
        return;
      }
      const inserted = await insertEarnBucket(tx, {
        creditOwnershipId: ownership.id,
        earnTransactionId: params.earnTransactionId,
        amount: params.amount,
        expiresAtMs: params.expiresAtMs,
      });
      if (inserted) {
        await trimBucketsToBalance(tx, ownership);
      }
    });
  }

  async setSuiCreditAccountId(ownershipId: string, suiCreditAccountId: string) {
    await this.db
      .update(creditOwnerships)
      .set({ suiCreditAccountId, updatedAt: new Date() })
      .where(eq(creditOwnerships.id, ownershipId));
  }

  /**
   * Records the on-chain receipt and resolves the pending reservation.
   *
   * `reservedPointsAmount` (what `recordEarnTransaction` moved into `pendingEarn`) and
   * `confirmedPointsAmount` (the `CreditEarned` event's actual `amount`) can differ: the chain
   * treats the requested `pointsAmount` as a purchase amount and credits the organization's policy
   * `earn_bps` share of it (e.g. 1% at 100 bps), not the number itself (see `chain-submit.processor.ts`). `pointsAmount` on
   * the loyalty transaction is corrected to the confirmed figure here — Sui is authoritative for
   * confirmed points (docs/architecture.md), the PG row at insert time was only a request.
   *
   * Returns null (and writes nothing) if the row is no longer PENDING — the other of
   * chain-submit worker / `domain/indexer` already resolved it. Pass `db` to run inside a
   * caller's transaction (it becomes a savepoint there).
   */
  async confirmEarnOnChain(
    params: {
      loyaltyTransactionId: string;
      organizationEndUserId: string;
      reservedPointsAmount: number;
      confirmedPointsAmount: number;
      digest: string;
      sender: string;
      /** The `CreditEarned` event's `bucket_expires_at_ms`; null skips the bucket (no expiry tracked). */
      bucketExpiresAtMs: number | null;
    },
    db: DrizzleDb = this.db,
  ) {
    return db.transaction(async (tx) => {
      const pending = await lockPendingTransaction(tx, params.loyaltyTransactionId);
      if (!pending) {
        return null;
      }

      const [blockchainTx] = await tx
        .insert(blockchainTransactions)
        .values({ digest: params.digest, sender: params.sender, status: 'CONFIRMED', confirmedAt: new Date() })
        .returning();

      await tx
        .update(loyaltyTransactions)
        .set({
          status: 'CONFIRMED',
          pointsAmount: params.confirmedPointsAmount,
          blockchainTransactionId: blockchainTx.id,
          updatedAt: new Date(),
        })
        .where(eq(loyaltyTransactions.id, params.loyaltyTransactionId));

      const ownership = await lockOwnership(tx, params.organizationEndUserId);
      if (ownership) {
        const newBalance = Number(ownership.confirmedBalance) + params.confirmedPointsAmount;
        await tx
          .update(creditOwnerships)
          .set({
            confirmedBalance: newBalance,
            pendingEarn: Number(ownership.pendingEarn) - params.reservedPointsAmount,
            lifetimeEarned: Number(ownership.lifetimeEarned) + params.confirmedPointsAmount,
            updatedAt: new Date(),
          })
          .where(eq(creditOwnerships.id, ownership.id));
        if (params.bucketExpiresAtMs !== null) {
          await insertEarnBucket(tx, {
            creditOwnershipId: ownership.id,
            earnTransactionId: params.loyaltyTransactionId,
            amount: params.confirmedPointsAmount,
            expiresAtMs: params.bucketExpiresAtMs,
          });
        }
        // Outbox (OCT-209): commits or rolls back with the confirm itself, and only the one caller
        // that got past the PENDING guard above ever reaches it.
        await enqueueWebhookEvent(tx, {
          organizationId: pending.organizationId,
          eventType: 'credits.earn.confirmed',
          payload: {
            transactionId: params.loyaltyTransactionId,
            organizationEndUserId: params.organizationEndUserId,
            pointsAmount: params.confirmedPointsAmount,
            newBalance,
            blockchainDigest: params.digest,
          },
        });
      }

      return blockchainTx;
    });
  }

  /** Reverts the optimistic `pendingEarn` bump and marks the command FAILED. */
  async failEarnOnChain(params: {
    loyaltyTransactionId: string;
    organizationEndUserId: string;
    reservedPointsAmount: number;
  }) {
    return this.db.transaction(async (tx) => {
      if (!(await lockPendingTransaction(tx, params.loyaltyTransactionId))) {
        return;
      }

      await tx
        .update(loyaltyTransactions)
        .set({ status: 'FAILED', updatedAt: new Date() })
        .where(eq(loyaltyTransactions.id, params.loyaltyTransactionId));

      const ownership = await lockOwnership(tx, params.organizationEndUserId);
      if (ownership) {
        await tx
          .update(creditOwnerships)
          .set({ pendingEarn: Number(ownership.pendingEarn) - params.reservedPointsAmount, updatedAt: new Date() })
          .where(eq(creditOwnerships.id, ownership.id));
      }
    });
  }

  async recordRedeemTransaction(params: {
    organizationId: string;
    organizationEndUserId: string;
    pointsAmount: number;
    idempotencyKey: string;
    receiptReference?: string;
    metadata?: Record<string, unknown>;
  }) {
    return withRls(this.db, { tenantId: params.organizationId, role: 'authenticated' }, async (tx) => {
      await expireDueBuckets(tx, params);
      const ownership = await tx.query.creditOwnerships.findFirst({
        where: eq(creditOwnerships.organizationEndUserId, params.organizationEndUserId),
      });

      if (!ownership || Number(ownership.confirmedBalance) < params.pointsAmount) {
        throw new Error(
          `Insufficient points: required ${params.pointsAmount}, available ${ownership?.confirmedBalance ?? 0}`,
        );
      }

      const [transaction] = await tx
        .insert(loyaltyTransactions)
        .values({
          organizationId: params.organizationId,
          organizationEndUserId: params.organizationEndUserId,
          transactionType: 'REDEEM',
          pointsAmount: params.pointsAmount,
          idempotencyKey: params.idempotencyKey,
          receiptReference: params.receiptReference,
          status: 'CONFIRMED',
          metadata: params.metadata ?? {},
        })
        .returning();

      const newConfirmedBalance = Number(ownership.confirmedBalance) - params.pointsAmount;
      const newLifetimeRedeemed = Number(ownership.lifetimeRedeemed) + params.pointsAmount;

      await tx
        .update(creditOwnerships)
        .set({
          confirmedBalance: newConfirmedBalance,
          lifetimeRedeemed: newLifetimeRedeemed,
          updatedAt: new Date(),
        })
        .where(eq(creditOwnerships.id, ownership.id));
      await consumeBuckets(tx, ownership.id, params.pointsAmount);

      return {
        transaction,
        newBalance: newConfirmedBalance,
      };
    });
  }

  async findOperationForClaim(organizationId: string, idempotencyKey: string) {
    return this.db.query.operations.findFirst({
      where: and(eq(operations.tenantId, organizationId), eq(operations.idempotencyKey, idempotencyKey)),
    });
  }

  async findVoucherClaimTransaction(ownershipId: string) {
    const claim = await this.db.query.voucherOwnerships.findFirst({ where: eq(voucherOwnerships.id, ownershipId) });
    return claim?.loyaltyTransactionId ? this.getLoyaltyTransactionById(claim.loyaltyTransactionId) : undefined;
  }

  /**
   * The hold behind a paid voucher claim, in the shape `PosRedemptionService.sponsorReservation`
   * takes: its REDEEM row, the member's on-chain account and any digest finalize already pinned.
   */
  async findVoucherClaimHold(organizationId: string, idempotencyKey: string) {
    const [hold] = await this.db
      .select({
        transaction: loyaltyTransactions,
        accountId: creditOwnerships.suiCreditAccountId,
        submittedDigest: operations.suiTxDigest,
      })
      .from(loyaltyTransactions)
      .innerJoin(
        operations,
        and(
          eq(operations.tenantId, loyaltyTransactions.organizationId),
          eq(operations.idempotencyKey, loyaltyTransactions.idempotencyKey),
        ),
      )
      .leftJoin(creditOwnerships, eq(creditOwnerships.organizationEndUserId, loyaltyTransactions.organizationEndUserId))
      .where(
        and(
          eq(loyaltyTransactions.organizationId, organizationId),
          eq(loyaltyTransactions.idempotencyKey, idempotencyKey),
        ),
      );
    return hold;
  }

  /**
   * Durably accepts a POS redemption request (OCT-55): moves `pointsAmount` into
   * `pendingRedemption` rather than deducting `confirmedBalance` yet — Sui is authoritative for
   * whether `credit_account::redeem` actually lands, not this request. Gated by OCT-43's
   * `acceptCommand`, checked *before* any balance/account read, so a reused idempotency key with
   * a different `organizationEndUserId`/`pointsAmount` is a clean conflict and never touches a
   * balance. `isNew: false` means this exact command was already accepted in a prior call — the
   * caller must not sponsor a new on-chain transaction for it, only resume reporting on the
   * existing one.
   */
  async reservePosRedemption(params: {
    organizationId: string;
    organizationEndUserId: string;
    pointsAmount: number;
    idempotencyKey: string;
    /** Age past which this reserve releases the member's never-finalized holds first. */
    abandonedHoldGraceMs?: number;
  }): Promise<{
    transaction: typeof loyaltyTransactions.$inferSelect;
    accountId: string | null;
    isNew: boolean;
    /** Digest a finalize already tried to execute for this hold (OCT-52), if any. */
    submittedDigest: string | null;
  }> {
    // Its own transaction, committed whatever happens to this reserve: a release must not roll back
    // just because the reserve below then fails its balance check. The caller's own key is left to
    // the retry path, which restarts that hold's clock instead.
    await withRls(this.db, { tenantId: params.organizationId, role: 'authenticated' }, (tx) =>
      releaseAbandonedPosHolds(tx, params, params.abandonedHoldGraceMs ?? ABANDONED_POS_HOLD_GRACE_MS, {
        exceptIdempotencyKey: params.idempotencyKey,
      }),
    );

    return withRls(this.db, { tenantId: params.organizationId, role: 'authenticated' }, async (tx) => {
      const { operation, isNew } = await acceptCommand(tx, {
        tenantId: params.organizationId,
        idempotencyKey: params.idempotencyKey,
        commandType: POS_RESERVE_COMMAND_TYPE,
        payload: {
          organizationEndUserId: params.organizationEndUserId,
          pointsAmount: params.pointsAmount,
        },
      });

      if (!isNew) {
        const findExisting = () =>
          tx.query.loyaltyTransactions.findFirst({
            where: and(
              eq(loyaltyTransactions.organizationId, params.organizationId),
              eq(loyaltyTransactions.idempotencyKey, params.idempotencyKey),
            ),
          });
        let existing = await findExisting();
        if (!existing) {
          throw new Error(`Operation ${operation.id} was already accepted but its loyalty transaction is missing`);
        }
        if (existing.status === 'PENDING' && !operation.suiTxDigest) {
          // A retry is the caller still working on this hold: restart its abandonment clock. Under
          // the same conditions the release checks, so the two serialize on this row: if another
          // reserve released the hold first, nothing is touched and the retry reports it settled
          // instead of sponsoring fresh bytes for a hold that no longer exists.
          const touched = await tx
            .update(operations)
            .set({ updatedAt: new Date() })
            .where(
              and(eq(operations.id, operation.id), eq(operations.status, 'PENDING'), isNull(operations.suiTxDigest)),
            )
            .returning({ id: operations.id });
          if (touched.length === 0) {
            existing = (await findExisting()) ?? existing;
          }
        }
        const ownership = await tx.query.creditOwnerships.findFirst({
          where: eq(creditOwnerships.organizationEndUserId, params.organizationEndUserId),
        });
        return {
          transaction: existing,
          accountId: ownership?.suiCreditAccountId ?? null,
          isNew: false,
          submittedDigest: operation.suiTxDigest,
        };
      }

      // A bucket past its expiry is already gone on-chain; holding against it would only fail at `redeem`.
      await expireDueBuckets(tx, params);
      // Locked: the balance check and the hold below must see every concurrent reserve's hold.
      const ownership = await lockOwnership(tx, params.organizationEndUserId);

      const available = ownership ? Number(ownership.confirmedBalance) - Number(ownership.pendingRedemption) : 0;
      if (!ownership || available < params.pointsAmount) {
        throw new Error(`Insufficient points: required ${params.pointsAmount}, available ${available}`);
      }
      if (!ownership.suiCreditAccountId) {
        throw new Error(`Member ${params.organizationEndUserId} has no on-chain CreditAccount yet (no prior earn)`);
      }

      const [transaction] = await tx
        .insert(loyaltyTransactions)
        .values({
          organizationId: params.organizationId,
          organizationEndUserId: params.organizationEndUserId,
          transactionType: 'REDEEM',
          pointsAmount: params.pointsAmount,
          idempotencyKey: params.idempotencyKey,
          status: 'PENDING',
          metadata: {},
        })
        .returning();

      await tx
        .update(creditOwnerships)
        .set({ pendingRedemption: Number(ownership.pendingRedemption) + params.pointsAmount, updatedAt: new Date() })
        .where(eq(creditOwnerships.id, ownership.id));

      return { transaction, accountId: ownership.suiCreditAccountId, isNew: true, submittedDigest: null };
    });
  }

  /**
   * Records a POS redemption's on-chain receipt and resolves its pending hold: moves
   * `pointsAmount` out of `pendingRedemption` into `confirmedBalance`/`lifetimeRedeemed`. Unlike
   * earn, the confirmed amount always equals what was reserved — `credit_account::redeem` debits
   * exactly `cost` on-chain or aborts outright, there is no policy-derived conversion.
   *
   * Same null-if-already-resolved and `db` contract as `confirmEarnOnChain`.
   */
  async confirmPosRedemptionOnChain(
    params: {
      loyaltyTransactionId: string;
      organizationEndUserId: string;
      pointsAmount: number;
      digest: string;
      sender: string;
    },
    db: DrizzleDb = this.db,
  ) {
    return db.transaction(async (tx) => {
      const pending = await lockPendingTransaction(tx, params.loyaltyTransactionId);
      if (!pending) {
        return null;
      }

      await settleVoucherClaim(tx, params.loyaltyTransactionId, true);
      const [blockchainTx] = await tx
        .insert(blockchainTransactions)
        .values({ digest: params.digest, sender: params.sender, status: 'CONFIRMED', confirmedAt: new Date() })
        .returning();

      await tx
        .update(loyaltyTransactions)
        .set({ status: 'CONFIRMED', blockchainTransactionId: blockchainTx.id, updatedAt: new Date() })
        .where(eq(loyaltyTransactions.id, params.loyaltyTransactionId));

      const ownership = await lockOwnership(tx, params.organizationEndUserId);
      if (ownership) {
        const newBalance = Number(ownership.confirmedBalance) - params.pointsAmount;
        await tx
          .update(creditOwnerships)
          .set({
            confirmedBalance: newBalance,
            pendingRedemption: Number(ownership.pendingRedemption) - params.pointsAmount,
            lifetimeRedeemed: Number(ownership.lifetimeRedeemed) + params.pointsAmount,
            updatedAt: new Date(),
          })
          .where(eq(creditOwnerships.id, ownership.id));
        await consumeBuckets(tx, ownership.id, params.pointsAmount);
        // Same outbox contract as `confirmEarnOnChain`.
        await enqueueWebhookEvent(tx, {
          organizationId: pending.organizationId,
          eventType: 'credits.redemption.confirmed',
          payload: {
            transactionId: params.loyaltyTransactionId,
            organizationEndUserId: params.organizationEndUserId,
            pointsAmount: params.pointsAmount,
            newBalance,
            blockchainDigest: params.digest,
          },
        });
      }

      return blockchainTx;
    });
  }

  /**
   * Releases a POS hold and marks it FAILED. Returns false when abandonment must yield to
   * finalize, and 'already-settled' when a previous attempt has already settled the loyalty row.
   */
  async failPosRedemptionOnChain(params: {
    loyaltyTransactionId: string;
    organizationEndUserId: string;
    pointsAmount: number;
    onlyIfUnsubmitted?: boolean;
  }) {
    return this.db.transaction(async (tx) => {
      let abandonedCommandId: string | undefined;
      if (params.onlyIfUnsubmitted) {
        const hold = await tx.query.loyaltyTransactions.findFirst({
          columns: { organizationId: true, idempotencyKey: true },
          where: eq(loyaltyTransactions.id, params.loyaltyTransactionId),
        });
        const [command] = hold
          ? await tx
              .select()
              .from(operations)
              .where(
                and(
                  eq(operations.tenantId, hold.organizationId),
                  eq(operations.idempotencyKey, hold.idempotencyKey),
                  eq(operations.commandType, VOUCHER_CLAIM_RESERVE_COMMAND_TYPE),
                ),
              )
              .for('update')
          : [];
        if (!command || command.suiTxDigest) return false;
        abandonedCommandId = command.id;
      }
      if (!(await lockPendingTransaction(tx, params.loyaltyTransactionId))) {
        return 'already-settled' as const;
      }

      if (abandonedCommandId) {
        await tx
          .update(operations)
          .set({ status: 'FAILED', errorMessage: 'Unsigned voucher claim expired', updatedAt: new Date() })
          .where(eq(operations.id, abandonedCommandId));
      }
      await settleVoucherClaim(tx, params.loyaltyTransactionId, false);
      await tx
        .update(loyaltyTransactions)
        .set({ status: 'FAILED', updatedAt: new Date() })
        .where(eq(loyaltyTransactions.id, params.loyaltyTransactionId));

      const ownership = await lockOwnership(tx, params.organizationEndUserId);
      if (ownership) {
        await tx
          .update(creditOwnerships)
          .set({ pendingRedemption: Number(ownership.pendingRedemption) - params.pointsAmount, updatedAt: new Date() })
          .where(eq(creditOwnerships.id, ownership.id));
      }
      return true;
    });
  }

  /**
   * Reverses a CONFIRMED EARN or REDEEM: marks the original REVERSED, inserts a REVERSAL row
   * linked to it via `reversesTransactionId`, and applies the opposite balance effect. A
   * reversed EARN that was already (partly) spent is allowed to drive `confirmedBalance`
   * negative — that negative balance *is* the clawback debt, and it already blocks further
   * redemptions via the balance check in `recordRedeemTransaction`.
   *
   * `original` must already be loaded and verified (right organization, CONFIRMED, EARN or
   * REDEEM) by the caller; the unique index on `reversesTransactionId` is the atomic backstop
   * if two reversal requests for the same original race each other.
   *
   * A paid voucher claim's points and coupon move together: reversing it cancels the coupon and
   * returns stock when the coupon's claim-time policy permits it. The domain evaluator runs under
   * catalog/ownership locks; denied refunds throw `VoucherClaimNotReversibleError` without writes.
   * An explicitly allowed used/expired refund preserves benefit history and never returns stock.
   */
  async recordReversalTransaction(params: {
    organizationId: string;
    original: typeof loyaltyTransactions.$inferSelect;
    idempotencyKey: string;
    reason?: string;
    evaluateRefund: (coupon: VoucherRefundContext, nowMs: number) => VoucherRefundDecision;
    refundedByCredentialId?: string;
  }) {
    return withRls(this.db, { tenantId: params.organizationId, role: 'authenticated' }, async (tx) => {
      const found = await tx.query.voucherOwnerships.findFirst({
        where: eq(voucherOwnerships.loyaltyTransactionId, params.original.id),
      });
      let refundAudit: Record<string, unknown> = {};
      if (found) {
        await tx.select({ id: vouchers.id }).from(vouchers).where(eq(vouchers.id, found.voucherId)).for('update');
        const [coupon] = await tx
          .select()
          .from(voucherOwnerships)
          .where(eq(voucherOwnerships.id, found.id))
          .for('update');
        const nowMs = Date.now();
        const decision = params.evaluateRefund(coupon, nowMs);
        if (!decision.allowed) throw new VoucherClaimNotReversibleError(decision.couponStatus, decision.reason);
        await tx
          .update(voucherOwnerships)
          .set({ status: decision.nextStatus, updatedAt: new Date(nowMs) })
          .where(eq(voucherOwnerships.id, coupon.id));
        if (decision.restock) await returnVoucherUnit(tx, coupon.voucherId);
        refundAudit = {
          voucherRefund: {
            policy: coupon.refundPolicySnapshot,
            couponStatus: coupon.status,
            restocked: decision.restock,
            decision: decision.reason,
            refundedByCredentialId: params.refundedByCredentialId,
          },
        };
      }

      const [reversedOriginal] = await tx
        .update(loyaltyTransactions)
        .set({ status: 'REVERSED', updatedAt: new Date() })
        .where(eq(loyaltyTransactions.id, params.original.id))
        .returning();
      const ownership = await lockOwnership(tx, params.original.organizationEndUserId);
      if (!ownership) {
        throw new Error('Credit ownership not found for this member');
      }

      const magnitude = Number(params.original.pointsAmount);
      // EARN added to confirmedBalance -> reversing subtracts (may go negative: clawback debt).
      // REDEEM subtracted from confirmedBalance -> reversing adds it back.
      const balanceDelta = params.original.transactionType === 'EARN' ? -magnitude : magnitude;
      const newConfirmedBalance = Number(ownership.confirmedBalance) + balanceDelta;

      await tx
        .update(creditOwnerships)
        .set({ confirmedBalance: newConfirmedBalance, updatedAt: new Date() })
        .where(eq(creditOwnerships.id, ownership.id));
      if (params.original.transactionType === 'EARN') {
        // Clawed-back points must not be forfeited a second time when the earn's bucket expires.
        // (A reversed REDEEM's add-back gets no bucket: it doesn't expire here — known gap.)
        await tx
          .update(creditBuckets)
          .set({ remaining: 0 })
          .where(eq(creditBuckets.earnTransactionId, params.original.id));
      }

      const [reversal] = await tx
        .insert(loyaltyTransactions)
        .values({
          organizationId: params.organizationId,
          organizationEndUserId: params.original.organizationEndUserId,
          transactionType: 'REVERSAL',
          pointsAmount: magnitude,
          idempotencyKey: params.idempotencyKey,
          receiptReference: params.reason,
          status: 'CONFIRMED',
          reversesTransactionId: params.original.id,
          metadata: { reversedTransactionType: params.original.transactionType, ...refundAudit },
        })
        .returning();

      // Mirror it on-chain (OCT-50) only if the original reached the chain: a chain-dispatched earn
      // POS redemption or a customer-signed voucher claim.
      if (params.original.blockchainTransactionId) {
        await acceptCommand(tx, {
          tenantId: params.organizationId,
          idempotencyKey: `reversal:${reversal.id}`,
          commandType: 'CREDIT_REVERSAL_CHAIN_SUBMIT',
          payload: {
            reversalTransactionId: reversal.id,
            reversedTransactionId: params.original.id,
            reversedTransactionType: params.original.transactionType,
            organizationEndUserId: params.original.organizationEndUserId,
            // The original's on-chain handle: an earn's `operation_key` is its idempotency key, a
            // POS redemption's `reference` is its own transaction id (see pos-redemption.service.ts),
            // a voucher claim's is its receipt reference (`voucherClaimReference`).
            chainKey:
              params.original.transactionType === 'EARN'
                ? params.original.idempotencyKey
                : parseVoucherClaimReference(params.original.receiptReference)
                  ? params.original.receiptReference
                  : params.original.id,
          },
        });
      }

      // Outbox (OCT-244), same contract as the `*.confirmed` events: queued in this transaction, so
      // the webhook exists exactly when the reversal does. A replayed key never reaches here.
      await enqueueWebhookEvent(tx, {
        organizationId: params.organizationId,
        eventType: 'credits.reversed',
        payload: {
          reversalTransactionId: reversal.id,
          reversedTransactionId: params.original.id,
          organizationEndUserId: params.original.organizationEndUserId,
          pointsAmount: magnitude,
          newBalance: newConfirmedBalance,
          balanceWentNegative: newConfirmedBalance < 0,
        },
      });

      return { reversal, reversedOriginal, newBalance: newConfirmedBalance };
    });
  }

  /**
   * Records the transaction that mirrored a reversal on-chain and links it to the REVERSAL row.
   * The reversal itself was already CONFIRMED in Postgres when it was accepted; this only adds its
   * chain proof. Returns null (and writes nothing) if a digest is already linked — the worker and
   * `ChainOutcomeReconciler` can both get here for the same command.
   */
  async recordReversalOnChain(params: { reversalTransactionId: string; digest: string; sender: string }) {
    return this.db.transaction(async (tx) => {
      const [reversal] = await tx
        .select()
        .from(loyaltyTransactions)
        .where(eq(loyaltyTransactions.id, params.reversalTransactionId))
        .for('update');
      if (!reversal || reversal.blockchainTransactionId) {
        return null;
      }
      const [blockchainTx] = await tx
        .insert(blockchainTransactions)
        .values({ digest: params.digest, sender: params.sender, status: 'CONFIRMED', confirmedAt: new Date() })
        .returning();
      await tx
        .update(loyaltyTransactions)
        .set({ blockchainTransactionId: blockchainTx.id, updatedAt: new Date() })
        .where(eq(loyaltyTransactions.id, reversal.id));
      return blockchainTx;
    });
  }

  async listTransactionsByMember(organizationId: string, organizationEndUserId: string, limit = 50) {
    return this.db.query.loyaltyTransactions.findMany({
      where: and(
        eq(loyaltyTransactions.organizationEndUserId, organizationEndUserId),
        eq(loyaltyTransactions.organizationId, organizationId),
      ),
      orderBy: [desc(loyaltyTransactions.createdAt)],
      limit,
      with: { blockchainTransaction: true },
    });
  }
}
