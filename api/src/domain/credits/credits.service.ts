import { Injectable } from '@nestjs/common';
import { CreditsRepository } from '../../infra/db/repositories/credits.repository.js';
import type { CreditBalanceSnapshot, LoyaltyTransactionDto } from '@octap/contracts';

@Injectable()
export class CreditsService {
  constructor(private readonly creditsRepo: CreditsRepository) {}

  async getBalance(organizationEndUserId: string): Promise<CreditBalanceSnapshot> {
    const ownership = await this.creditsRepo.getOrCreateCreditOwnership(organizationEndUserId);

    return {
      organizationEndUserId,
      confirmedBalance: Number(ownership.confirmedBalance),
      pendingEarn: Number(ownership.pendingEarn),
      pendingRedemption: Number(ownership.pendingRedemption),
      lifetimeEarned: Number(ownership.lifetimeEarned),
      lifetimeRedeemed: Number(ownership.lifetimeRedeemed),
      asOfCheckpoint: ownership.asOfCheckpoint,
    };
  }

  async listTransactions(organizationEndUserId: string, limit = 50): Promise<LoyaltyTransactionDto[]> {
    const records = await this.creditsRepo.listTransactionsByMember(organizationEndUserId, limit);

    return records.map((tx) => ({
      id: tx.id,
      organizationId: tx.organizationId,
      organizationEndUserId: tx.organizationEndUserId,
      createdByMembershipId: tx.createdByMembershipId,
      blockchainTransactionId: tx.blockchainTransactionId,
      blockchainDigest: tx.blockchainTransaction?.digest ?? null,
      transactionType: tx.transactionType,
      pointsAmount: Number(tx.pointsAmount),
      idempotencyKey: tx.idempotencyKey,
      receiptReference: tx.receiptReference,
      status: tx.status,
      metadata: tx.metadata as Record<string, unknown> | null,
      createdAt: tx.createdAt.toISOString(),
      updatedAt: tx.updatedAt.toISOString(),
    }));
  }
}
