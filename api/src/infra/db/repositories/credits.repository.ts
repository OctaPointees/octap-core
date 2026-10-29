import { Inject, Injectable } from '@nestjs/common';
import { eq, desc, and, asc, gt, lte, inArray, sql } from 'drizzle-orm';
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
export async function consumeBuckets(tx: DrizzleDb, creditOwnershipId: string, amount: number, nowMs = Date.now()) {
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
  if (changed && !confirmed) {
    await tx
      .update(vouchers)
      .set({
        claimedCount: sql`${vouchers.claimedCount} - 1`,
        status: sql`case when ${vouchers.status} = 'DEPLETED' then 'ACTIVE'::voucher_status else ${vouchers.status} end`,
        updatedAt: new Date(),
      })
      .where(eq(vouchers.id, claim.voucherId));
  }
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
  async findOperationForClaim(organizationId: string, idempotencyKey: string) {
    return this.db.query.operations.findFirst({
      where: and(eq(operations.tenantId, organizationId), eq(operations.idempotencyKey, idempotencyKey)),
    });
  }

  async findVoucherClaimTransaction(ownershipId: string) {
    const claim = await this.db.query.voucherOwnerships.findFirst({ where: eq(voucherOwnerships.id, ownershipId) });
    return claim?.loyaltyTransactionId ? this.getLoyaltyTransactionById(claim.loyaltyTransactionId) : undefined;
  }

  async reservePosRedemption(params: {
    organizationId: string;
    organizationEndUserId: string;
    pointsAmount: number;
    idempotencyKey: string;
  }): Promise<{
    transaction: typeof loyaltyTransactions.$inferSelect;
    accountId: string | null;
    isNew: boolean;
    /** Digest a finalize already tried to execute for this hold (OCT-52), if any. */
    submittedDigest: string | null;
  }> {
    return withRls(this.db, { tenantId: params.organizationId, role: 'authenticated' }, async (tx) => {
      const { operation, isNew } = await acceptCommand(tx, {
        tenantId: params.organizationId,
        idempotencyKey: params.idempotencyKey,
        commandType: 'CREDIT_POS_REDEEM_RESERVE',
        payload: {
          organizationEndUserId: params.organizationEndUserId,
          pointsAmount: params.pointsAmount,
        },
      });

      if (!isNew) {
        const existing = await tx.query.loyaltyTransactions.findFirst({
          where: and(
            eq(loyaltyTransactions.organizationId, params.organizationId),
            eq(loyaltyTransactions.idempotencyKey, params.idempotencyKey),
          ),
        });
        if (!existing) {
          throw new Error(`Operation ${operation.id} was already accepted but its loyalty transaction is missing`);
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

  /** Releases a POS redemption's pending hold (confirmedBalance untouched) and marks it FAILED. */
  async failPosRedemptionOnChain(params: {
    loyaltyTransactionId: string;
    organizationEndUserId: string;
    pointsAmount: number;
    onlyIfUnsubmitted?: boolean;
  }) {
    return this.db.transaction(async (tx) => {
      let abandonedCommandId: string | undefined;
      if (params.onlyIfUnsubmitted) {
        const [command] = await tx
          .select()
          .from(operations)
          .where(
            and(
              eq(operations.commandType, 'CREDIT_POS_REDEEM_RESERVE'),
              sql`${operations.payload}->>'voucherOwnershipId' is not null`,
              eq(
                operations.idempotencyKey,
                sql`(select idempotency_key from loyalty_transactions where id = ${params.loyaltyTransactionId})`,
              ),
              eq(
                operations.tenantId,
                sql`(select organization_id from loyalty_transactions where id = ${params.loyaltyTransactionId})`,
              ),
            ),
          )
          .for('update');
        if (!command || command.suiTxDigest) return false;
        abandonedCommandId = command.id;
      }
      if (!(await lockPendingTransaction(tx, params.loyaltyTransactionId))) {
        return false;
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
   */
  async recordReversalTransaction(params: {
    organizationId: string;
    original: typeof loyaltyTransactions.$inferSelect;
    idempotencyKey: string;
    reason?: string;
  }) {
    return withRls(this.db, { tenantId: params.organizationId, role: 'authenticated' }, async (tx) => {
      const [reversedOriginal] = await tx
        .update(loyaltyTransactions)
        .set({ status: 'REVERSED', updatedAt: new Date() })
        .where(eq(loyaltyTransactions.id, params.original.id))
        .returning();

      const coupon = await tx.query.voucherOwnerships.findFirst({
        where: eq(voucherOwnerships.loyaltyTransactionId, params.original.id),
      });
      if (coupon) {
        await tx.select({ id: vouchers.id }).from(vouchers).where(eq(vouchers.id, coupon.voucherId)).for('share');
        await tx
          .update(voucherOwnerships)
          .set({ status: 'CANCELLED', updatedAt: new Date() })
          .where(and(eq(voucherOwnerships.id, coupon.id), eq(voucherOwnerships.status, 'AVAILABLE')));
      }
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
          metadata: { reversedTransactionType: params.original.transactionType },
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
            // POS redemption's `reference` is its own transaction id (see pos-redemption.service.ts).
            chainKey:
              params.original.transactionType === 'EARN'
                ? params.original.idempotencyKey
                : params.original.receiptReference?.startsWith('voucher-claim-')
                  ? params.original.receiptReference
                  : params.original.id,
          },
        });
      }

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
