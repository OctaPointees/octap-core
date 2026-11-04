import { Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import { OperationPayloadConflictError } from '#infra/db/repositories/operations.repository.js';
import { ProgramsRepository } from '#infra/db/repositories/programs.repository.js';
import { WebhookDeliveryService } from '../webhooks/webhook-delivery.service.js';
import { requireProgramConfig } from '../programs/program-config.js';
import type { EarnPointsRequest, EarnPointsResponse } from '@octap/contracts';
import { mapMemberEligibilityError } from './member-eligibility-error.js';

type LoyaltyTransaction = Awaited<ReturnType<CreditsRepository['recordEarnTransaction']>>['transaction'];

function toEarnResponse(transaction: LoyaltyTransaction, newBalance: number): EarnPointsResponse {
  return {
    transactionId: transaction.id,
    organizationEndUserId: transaction.organizationEndUserId,
    purchaseAmount: transaction.purchaseAmount,
    estimatedPoints: transaction.status === 'PENDING' ? transaction.pointsAmount : null,
    pointsEarned:
      transaction.status === 'CONFIRMED' || transaction.status === 'REVERSED' ? transaction.pointsAmount : null,
    newBalance,
    status: transaction.status,
    idempotencyKey: transaction.idempotencyKey,
  };
}

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

    // A retry under an accepted key skips the gates: it only reports the existing earn.
    const accepted = await this.creditsRepo.findTransactionByIdempotency(organizationId, request.idempotencyKey);
    const estimatedPoints = accepted
      ? accepted.pointsAmount
      : await this.estimatePoints(organizationId, request.purchaseAmount);

    const { transaction, newBalance, isNew } = await this.creditsRepo
      .recordEarnTransaction({
        organizationId,
        organizationEndUserId: request.organizationEndUserId,
        purchaseAmount: request.purchaseAmount,
        estimatedPoints,
        idempotencyKey: request.idempotencyKey,
        receiptReference: request.receiptReference,
        metadata: request.metadata,
      })
      .catch((error: unknown) => {
        if (error instanceof OperationPayloadConflictError) throw new ConflictException(error.message);
        throw mapMemberEligibilityError(error);
      });

    if (isNew) {
      await this.webhooks.emit(organizationId, 'credits.earned', {
        transactionId: transaction.id,
        organizationEndUserId: transaction.organizationEndUserId,
        purchaseAmount: request.purchaseAmount,
        estimatedPoints,
        newBalance,
      });
    }

    return toEarnResponse(transaction, newBalance);
  }

  /** Rejects before reserving anything: the chain-submit worker would otherwise fail the earn after it was accepted. */
  private async estimatePoints(organizationId: string, purchaseAmount: number): Promise<number> {
    const { earnBps } = await requireProgramConfig(this.programsRepo, organizationId);
    // Integer arithmetic matches Move's floor(purchase * earn_bps / 10_000), which aborts on zero.
    const estimate = (BigInt(purchaseAmount) * BigInt(earnBps)) / 10_000n;
    if (estimate === 0n) {
      throw new BadRequestException('Purchase amount is too small to earn any points');
    }
    if (estimate > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new BadRequestException('Estimated points exceed safe integer range');
    }
    return Number(estimate);
  }
}
