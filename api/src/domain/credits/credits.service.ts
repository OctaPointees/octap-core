import { Injectable, NotFoundException } from '@nestjs/common';
import { CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import { CREDIT_ACCOUNT_STREAM, IndexerRepository } from '#infra/db/repositories/indexer.repository.js';
import type { CreditBalanceSnapshot, LoyaltyTransactionDto } from '@octap/contracts';

@Injectable()
export class CreditsService {
  constructor(
    private readonly creditsRepo: CreditsRepository,
    private readonly indexerRepo: IndexerRepository,
  ) {}

  /**
   * `asOfCheckpoint` is the indexer's stream-wide progress (last checkpoint it projected), not
   * per-member. `stale` is the simple, literal rule: any pending amount means part of this balance
   * can still change. Comparing the indexer against the chain's current tip is future work.
   */
  async getBalance(organizationId: string, organizationEndUserId: string): Promise<CreditBalanceSnapshot> {
    await this.assertMemberBelongsToOrganization(organizationId, organizationEndUserId);
    // Lazy expiry: a bucket past its `expires_at_ms` must not count, even before the chain says so.
    await this.creditsRepo.expireDueBucketsForMember({ organizationId, organizationEndUserId });
    const [ownership, cursor] = await Promise.all([
      this.creditsRepo.getOrCreateCreditOwnership(organizationEndUserId),
      this.indexerRepo.getCursor(CREDIT_ACCOUNT_STREAM),
    ]);
    const pendingEarn = Number(ownership.pendingEarn);
    const pendingRedemption = Number(ownership.pendingRedemption);

    return {
      organizationEndUserId,
      confirmedBalance: Number(ownership.confirmedBalance),
      pendingEarn,
      pendingRedemption,
      lifetimeEarned: Number(ownership.lifetimeEarned),
      lifetimeRedeemed: Number(ownership.lifetimeRedeemed),
      asOfCheckpoint: cursor?.lastCheckpoint ?? null,
      observedAt: new Date().toISOString(),
      stale: pendingEarn > 0 || pendingRedemption > 0,
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

  private async assertMemberBelongsToOrganization(organizationId: string, organizationEndUserId: string) {
    const memberOrgId = await this.creditsRepo.findMemberOrganizationId(organizationEndUserId);
    if (memberOrgId !== organizationId) {
      throw new NotFoundException(`Member ${organizationEndUserId} was not found for this organization`);
    }
  }
}
