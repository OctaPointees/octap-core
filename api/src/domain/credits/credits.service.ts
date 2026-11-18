import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ProgramsRepository } from '#infra/db/repositories/programs.repository.js';
import { CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import { CREDIT_ACCOUNT_STREAM, IndexerRepository } from '#infra/db/repositories/indexer.repository.js';
import type { CreditBalanceSnapshot, LoyaltyTransactionDto, LoyaltyTransactionPage } from '@octap/contracts';
import type { loyaltyTransactions } from '#infra/db/schema/credits.schema.js';
import { UUID_PATTERN } from '#infra/db/repositories/console-access.js';

@Injectable()
export class CreditsService {
  constructor(
    private readonly creditsRepo: CreditsRepository,
    private readonly indexerRepo: IndexerRepository,
    private readonly programsRepo: ProgramsRepository,
  ) {}

  /**
   * `asOfCheckpoint` is the indexer's stream-wide progress (last checkpoint it projected), not
   * per-member. `stale` is the simple, literal rule: any pending amount means part of this balance
   * can still change. Comparing the indexer against the chain's current tip is future work.
   */
  async getBalance(
    organizationId: string,
    organizationEndUserId: string,
    programId?: string,
  ): Promise<CreditBalanceSnapshot> {
    await this.assertMemberBelongsToOrganization(organizationId, organizationEndUserId);
    if (programId !== undefined) {
      const program = await this.programsRepo.findByOrganization(organizationId);
      if (!program || (program.id !== programId && program.programControlId !== programId)) {
        throw new NotFoundException('Program was not found for this organization');
      }
    }
    // Lazy expiry: a bucket past its `expires_at_ms` must not count, even before the chain says so.
    await this.creditsRepo.expireDueBucketsForMember({ organizationId, organizationEndUserId });
    // Same lazy rule for an abandoned POS reserve (OCT-244): its hold must not linger in `pendingRedemption`.
    await this.creditsRepo.releaseAbandonedPosHoldsForMember({ organizationId, organizationEndUserId });
    const [ownership, cursor] = await Promise.all([
      this.creditsRepo.getOrCreateCreditOwnership(organizationId, organizationEndUserId),
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

  /**
   * One page of a member's history, newest first, for both the API-key and console routes.
   * `limit` 1–100 (default 25); `cursor` is the previous page's `nextCursor`. A cursor that is not
   * one of this member's transactions is a 400, never an empty page that looks like the end.
   */
  async listTransactions(
    organizationId: string,
    organizationEndUserId: string,
    query: { limit?: unknown; cursor?: unknown } = {},
  ): Promise<LoyaltyTransactionPage> {
    const limit = query.limit === undefined || query.limit === '' ? 25 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('limit must be 1–100');
    const cursor = query.cursor === undefined || query.cursor === '' ? undefined : query.cursor;
    if (cursor !== undefined && (typeof cursor !== 'string' || !UUID_PATTERN.test(cursor)))
      throw new BadRequestException('Invalid cursor');
    await this.assertMemberBelongsToOrganization(organizationId, organizationEndUserId);
    const page = await this.creditsRepo.listTransactionPageByMember(
      organizationId,
      organizationEndUserId,
      limit,
      cursor,
    );
    if (!page) throw new BadRequestException('Invalid cursor');
    return { items: page.rows.map(({ row, digest }) => toTransactionDto(row, digest)), nextCursor: page.nextCursor };
  }

  private async assertMemberBelongsToOrganization(organizationId: string, organizationEndUserId: string) {
    const memberOrgId = await this.creditsRepo.findMemberOrganizationId(organizationEndUserId);
    if (memberOrgId !== organizationId) {
      throw new NotFoundException(`Member ${organizationEndUserId} was not found for this organization`);
    }
  }
}

/** An unconfirmed earn shows no points yet, only its estimate: the chain decides the final amount. */
function toTransactionDto(tx: typeof loyaltyTransactions.$inferSelect, digest: string | null): LoyaltyTransactionDto {
  return {
    id: tx.id,
    organizationId: tx.organizationId,
    organizationEndUserId: tx.organizationEndUserId,
    createdByMembershipId: tx.createdByMembershipId,
    blockchainTransactionId: tx.blockchainTransactionId,
    blockchainDigest: digest,
    transactionType: tx.transactionType,
    pointsAmount:
      tx.transactionType === 'EARN' && (tx.status === 'PENDING' || tx.status === 'FAILED')
        ? null
        : Number(tx.pointsAmount),
    purchaseAmount: tx.purchaseAmount,
    estimatedPoints: tx.transactionType === 'EARN' && tx.status === 'PENDING' ? Number(tx.pointsAmount) : null,
    idempotencyKey: tx.idempotencyKey,
    receiptReference: tx.receiptReference,
    status: tx.status,
    metadata: tx.metadata as Record<string, unknown> | null,
    createdAt: tx.createdAt.toISOString(),
    updatedAt: tx.updatedAt.toISOString(),
  };
}
