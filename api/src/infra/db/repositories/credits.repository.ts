import { Inject, Injectable } from '@nestjs/common';
import { eq, desc } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { creditOwnerships, loyaltyTransactions } from '../schema/credits.schema.js';

@Injectable()
export class CreditsRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

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

  async recordEarnTransaction(params: {
    organizationId: string;
    organizationEndUserId: string;
    pointsAmount: number;
    idempotencyKey: string;
    receiptReference?: string;
    metadata?: Record<string, unknown>;
  }) {
    return this.db.transaction(async (tx) => {
      // 1. Get or create ownership
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

      // 2. Insert loyalty transaction
      const [transaction] = await tx
        .insert(loyaltyTransactions)
        .values({
          organizationId: params.organizationId,
          organizationEndUserId: params.organizationEndUserId,
          transactionType: 'EARN',
          pointsAmount: params.pointsAmount,
          idempotencyKey: params.idempotencyKey,
          receiptReference: params.receiptReference,
          status: 'CONFIRMED',
          metadata: params.metadata ?? {},
        })
        .returning();

      // 3. Increment confirmedBalance and lifetimeEarned
      const newConfirmedBalance = Number(ownership.confirmedBalance) + params.pointsAmount;
      const newLifetimeEarned = Number(ownership.lifetimeEarned) + params.pointsAmount;

      await tx
        .update(creditOwnerships)
        .set({
          confirmedBalance: newConfirmedBalance,
          lifetimeEarned: newLifetimeEarned,
          updatedAt: new Date(),
        })
        .where(eq(creditOwnerships.id, ownership.id));

      return {
        transaction,
        newBalance: newConfirmedBalance,
      };
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

  async listTransactionsByMember(organizationEndUserId: string, limit = 50) {
    return this.db.query.loyaltyTransactions.findMany({
      where: eq(loyaltyTransactions.organizationEndUserId, organizationEndUserId),
      orderBy: [desc(loyaltyTransactions.createdAt)],
      limit,
    });
  }
}
