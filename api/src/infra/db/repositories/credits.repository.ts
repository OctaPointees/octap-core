import { Inject, Injectable } from '@nestjs/common';
import { eq, desc, and } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { blockchainTransactions, creditOwnerships, loyaltyTransactions } from '../schema/credits.schema.js';
import { operations } from '../schema/operations.schema.js';
import { organizationEndUsers } from '../schema/members.schema.js';

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
    return this.db.transaction(async (tx) => {
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

      await tx.insert(operations).values({
        tenantId: params.organizationId,
        idempotencyKey: params.idempotencyKey,
        commandType: 'CREDIT_EARN_CHAIN_SUBMIT',
        status: 'PENDING',
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
   */
  async confirmEarnOnChain(params: {
    loyaltyTransactionId: string;
    organizationEndUserId: string;
    reservedPointsAmount: number;
    confirmedPointsAmount: number;
    digest: string;
    sender: string;
  }) {
    return this.db.transaction(async (tx) => {
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
    return this.db.transaction(async (tx) => {
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
    return this.db.transaction(async (tx) => {
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
