import { Injectable, NotFoundException } from '@nestjs/common';
import { CreditsRepository } from '../../infra/db/repositories/credits.repository.js';
import type { CreditBalanceSnapshot, LoyaltyTransactionDto } from '@octap/contracts';

@Injectable()
export class CreditsService {
  constructor(private readonly creditsRepo: CreditsRepository) {}

  async getBalance(organizationId: string, organizationEndUserId: string): Promise<CreditBalanceSnapshot> {
    await this.assertMemberBelongsToOrganization(organizationId, organizationEndUserId);
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

  async listTransactions(
    organizationId: string,
    organizationEndUserId: string,
    limit = 50,
  ): Promise<LoyaltyTransactionDto[]> {
    await this.assertMemberBelongsToOrganization(organizationId, organizationEndUserId);
    const records = await this.creditsRepo.listTransactionsByMember(organizationId, organizationEndUserId, limit);

    return records.map((tx) => ({
      id: tx.id,
      organizationId: tx.organizationId,
      organizationEndUserId: tx.organizationEndUserId,
      createdByMembershipId: tx.createdByMembershipId,
      blockchainTransactionId: tx.blockchainTransactionId,
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

  private async assertMemberBelongsToOrganization(organizationId: string, organizationEndUserId: string) {
    const memberOrgId = await this.creditsRepo.findMemberOrganizationId(organizationEndUserId);
    if (memberOrgId !== organizationId) {
      throw new NotFoundException(`Member ${organizationEndUserId} was not found for this organization`);
    }
  }
}
