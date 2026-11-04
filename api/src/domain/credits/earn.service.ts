import { Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import { ProgramsRepository } from '#infra/db/repositories/programs.repository.js';
import { WebhookDeliveryService } from '../webhooks/webhook-delivery.service.js';
import { requireProgramConfig } from '../programs/program-config.js';
import type { EarnPointsRequest, EarnPointsResponse } from '@octap/contracts';
import { hashPayload } from '#infra/db/repositories/operations.repository.js';
import { mapMemberEligibilityError } from './member-eligibility-error.js';

@Injectable()
export class EarnService {
  constructor(
    private readonly creditsRepo: CreditsRepository,
    private readonly webhooks: WebhookDeliveryService,
    private readonly programsRepo: ProgramsRepository,
  ) {}

  async executeEarn(organizationId: string, request: EarnPointsRequest): Promise<EarnPointsResponse> {
    if (!Number.isSafeInteger(request.purchaseAmount) || request.purchaseAmount <= 0) {
      throw new BadRequestException('Purchase amount must be a safe integer greater than zero');
    }
    const memberOrgId = await this.creditsRepo.findMemberOrganizationId(request.organizationEndUserId);
    if (memberOrgId !== organizationId) {
      throw new NotFoundException(`Member ${request.organizationEndUserId} was not found for this organization`);
    }
    const response = (
      tx: NonNullable<Awaited<ReturnType<CreditsRepository['findTransactionByIdempotency']>>>,
      newBalance: number,
    ): EarnPointsResponse => ({
      transactionId: tx.id,
      organizationEndUserId: tx.organizationEndUserId,
      purchaseAmount: tx.purchaseAmount,
      estimatedPoints: tx.status === 'PENDING' ? tx.pointsAmount : null,
      pointsEarned: tx.status === 'CONFIRMED' || tx.status === 'REVERSED' ? tx.pointsAmount : null,
      newBalance,
      status: tx.status,
      idempotencyKey: tx.idempotencyKey,
    });
    const replay = async (tx: NonNullable<Awaited<ReturnType<CreditsRepository['findTransactionByIdempotency']>>>) => {
      if (
        tx.transactionType !== 'EARN' ||
        tx.organizationEndUserId !== request.organizationEndUserId ||
        tx.purchaseAmount !== request.purchaseAmount ||
        tx.receiptReference !== (request.receiptReference ?? null) ||
        hashPayload((tx.metadata ?? {}) as Record<string, unknown>) !== hashPayload(request.metadata ?? {})
      ) {
        throw new ConflictException('Idempotency key was already used with a different earn request');
      }
      const ownership = await this.creditsRepo.getOrCreateCreditOwnership(tx.organizationEndUserId);
      return response(tx, Number(ownership.confirmedBalance));
    };
    const existing = await this.creditsRepo.findTransactionByIdempotency(organizationId, request.idempotencyKey);
    if (existing) return replay(existing);

    await requireProgramConfig(this.programsRepo, organizationId);
    const program = (await this.programsRepo.findByOrganization(organizationId))!;
    // Integer arithmetic matches Move's floor(purchase * earn_bps / 10_000).
    const estimate = (BigInt(request.purchaseAmount) * BigInt(program.earnBps)) / 10_000n;
    if (estimate > BigInt(Number.MAX_SAFE_INTEGER))
      throw new BadRequestException('Estimated points exceed safe integer range');
    let recorded: Awaited<ReturnType<CreditsRepository['recordEarnTransaction']>>;
    try {
      recorded = await this.creditsRepo.recordEarnTransaction({
        organizationId,
        organizationEndUserId: request.organizationEndUserId,
        purchaseAmount: request.purchaseAmount,
        estimatedPoints: Number(estimate),
        idempotencyKey: request.idempotencyKey,
        receiptReference: request.receiptReference,
        metadata: request.metadata,
      });
    } catch (error: unknown) {
      // A concurrent request may have committed the same key after the initial lookup.
      const winner = await this.creditsRepo.findTransactionByIdempotency(organizationId, request.idempotencyKey);
      if (winner) return replay(winner);
      throw mapMemberEligibilityError(error);
    }
    const { transaction, newBalance } = recorded;
    await this.webhooks.emit(organizationId, 'credits.earned', {
      transactionId: transaction.id,
      organizationEndUserId: transaction.organizationEndUserId,
      purchaseAmount: request.purchaseAmount,
      estimatedPoints: Number(estimate),
      newBalance,
    });
    return response(transaction, newBalance);
  }
}
