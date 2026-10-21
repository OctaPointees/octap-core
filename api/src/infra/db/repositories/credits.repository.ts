import { Inject, Injectable } from '@nestjs/common';
import { eq, desc, and } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { blockchainTransactions, creditOwnerships, loyaltyTransactions } from '../schema/credits.schema.js';
import { acceptCommand } from './operations.repository.js';
import { endUsers, organizationEndUsers } from '../schema/members.schema.js';
import { withRls } from '../rls.js';

/**
 * Row-locks a loyalty transaction and reports whether it is still PENDING. Every chain-outcome
 * writer (`confirm*OnChain`/`fail*OnChain`) calls this first, so the synchronous path (chain-submit
 * worker, POS finalize) and `domain/indexer` can race on the same row and exactly one resolves it;
 * the loser sees a non-PENDING row and does nothing instead of re-applying the balance effect.
 */
async function lockPendingTransaction(tx: DrizzleDb, loyaltyTransactionId: string): Promise<boolean> {
  const [row] = await tx
    .select({ status: loyaltyTransactions.status })
    .from(loyaltyTransactions)
    .where(eq(loyaltyTransactions.id, loyaltyTransactionId))
    .for('update');
  return row?.status === 'PENDING';
}

/**
 * Row-locks a member's credit ownership. Callers compute absolute balances from this snapshot, so
 * it must be locked: two concurrent writers for the same member (e.g. two POS reserves) would
 * otherwise both read the same row and one delta would be lost.
 */
async function lockOwnership(tx: DrizzleDb, organizationEndUserId: string) {
  const [row] = await tx
    .select()
    .from(creditOwnerships)
    .where(eq(creditOwnerships.organizationEndUserId, organizationEndUserId))
    .for('update');
  return row;
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
   * `confirmedPointsAmount` (the `CreditEarned` event's actual `amount`) can differ: the demo
   * policy is 100 bps, so the chain treats the requested `pointsAmount` as a purchase amount and
   * credits 1% of it, not the number itself (see `chain-submit.processor.ts`). `pointsAmount` on
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
    },
    db: DrizzleDb = this.db,
  ) {
    return db.transaction(async (tx) => {
      if (!(await lockPendingTransaction(tx, params.loyaltyTransactionId))) {
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

      const ownership = await tx.query.creditOwnerships.findFirst({
        where: eq(creditOwnerships.organizationEndUserId, params.organizationEndUserId),
      });
      if (ownership) {
        await tx
          .update(creditOwnerships)
          .set({
            confirmedBalance: Number(ownership.confirmedBalance) + params.confirmedPointsAmount,
            pendingEarn: Number(ownership.pendingEarn) - params.reservedPointsAmount,
            lifetimeEarned: Number(ownership.lifetimeEarned) + params.confirmedPointsAmount,
            updatedAt: new Date(),
          })
          .where(eq(creditOwnerships.id, ownership.id));
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

      const ownership = await tx.query.creditOwnerships.findFirst({
        where: eq(creditOwnerships.organizationEndUserId, params.organizationEndUserId),
      });
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
      const ownership = await tx.query.creditOwnerships.findFirst({
        where: eq(creditOwnerships.organizationEndUserId, params.organizationEndUserId),
      });

      if (!ownership || Number(ownership.confirmedBalance) < params.pointsAmount) {
        throw new Error(`Insufficient points: required ${params.pointsAmount}, available ${ownership?.confirmedBalance ?? 0}`);
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
  async reservePosRedemption(params: {
    organizationId: string;
    organizationEndUserId: string;
    pointsAmount: number;
    idempotencyKey: string;
  }): Promise<{ transaction: typeof loyaltyTransactions.$inferSelect; accountId: string | null; isNew: boolean }> {
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
        return { transaction: existing, accountId: ownership?.suiCreditAccountId ?? null, isNew: false };
      }

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

      return { transaction, accountId: ownership.suiCreditAccountId, isNew: true };
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
      if (!(await lockPendingTransaction(tx, params.loyaltyTransactionId))) {
        return null;
      }

      const [blockchainTx] = await tx
        .insert(blockchainTransactions)
        .values({ digest: params.digest, sender: params.sender, status: 'CONFIRMED', confirmedAt: new Date() })
        .returning();

      await tx
        .update(loyaltyTransactions)
        .set({ status: 'CONFIRMED', blockchainTransactionId: blockchainTx.id, updatedAt: new Date() })
        .where(eq(loyaltyTransactions.id, params.loyaltyTransactionId));

      const ownership = await tx.query.creditOwnerships.findFirst({
        where: eq(creditOwnerships.organizationEndUserId, params.organizationEndUserId),
      });
      if (ownership) {
        await tx
          .update(creditOwnerships)
          .set({
            confirmedBalance: Number(ownership.confirmedBalance) - params.pointsAmount,
            pendingRedemption: Number(ownership.pendingRedemption) - params.pointsAmount,
            lifetimeRedeemed: Number(ownership.lifetimeRedeemed) + params.pointsAmount,
            updatedAt: new Date(),
          })
          .where(eq(creditOwnerships.id, ownership.id));
      }

      return blockchainTx;
    });
  }

  /** Releases a POS redemption's pending hold (confirmedBalance untouched) and marks it FAILED. */
  async failPosRedemptionOnChain(params: {
    loyaltyTransactionId: string;
    organizationEndUserId: string;
    pointsAmount: number;
  }) {
    return this.db.transaction(async (tx) => {
      if (!(await lockPendingTransaction(tx, params.loyaltyTransactionId))) {
        return;
      }

      await tx
        .update(loyaltyTransactions)
        .set({ status: 'FAILED', updatedAt: new Date() })
        .where(eq(loyaltyTransactions.id, params.loyaltyTransactionId));

      const ownership = await tx.query.creditOwnerships.findFirst({
        where: eq(creditOwnerships.organizationEndUserId, params.organizationEndUserId),
      });
      if (ownership) {
        await tx
          .update(creditOwnerships)
          .set({ pendingRedemption: Number(ownership.pendingRedemption) - params.pointsAmount, updatedAt: new Date() })
          .where(eq(creditOwnerships.id, ownership.id));
      }
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

      const ownership = await tx.query.creditOwnerships.findFirst({
        where: eq(creditOwnerships.organizationEndUserId, params.original.organizationEndUserId),
      });
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

      return { reversal, reversedOriginal, newBalance: newConfirmedBalance };
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
