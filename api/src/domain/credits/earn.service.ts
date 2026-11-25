import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import { OperationPayloadConflictError } from '#infra/db/repositories/operations.repository.js';
import { ProgramsRepository } from '#infra/db/repositories/programs.repository.js';
import { requireProgramConfig } from '../programs/program-config.js';
import type { EarnPointsRequest, EarnPointsResponse } from '@octap/contracts';
import { IssuanceBudgetService } from './issuance-budget.service.js';
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

/**
 * `floor(purchaseAmount * earnBps / 10000)` with integer arithmetic, as Move computes it on-chain.
 * Throws 400 when it rounds to zero (the chain would abort) or leaves the safe-integer range.
 * Shared with the sandbox (OCT-297), so a sandbox earn credits exactly what a live one would.
 */
export function pointsForPurchase(purchaseAmount: number, earnBps: number): number {
  if (!Number.isSafeInteger(purchaseAmount) || purchaseAmount <= 0) {
    throw new BadRequestException('Purchase amount must be a safe integer greater than zero');
  }
  const estimate = (BigInt(purchaseAmount) * BigInt(earnBps)) / 10_000n;
  if (estimate === 0n) {
    throw new BadRequestException('Purchase amount is too small to earn any points');
  }
  if (estimate > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new BadRequestException('Estimated points exceed safe integer range');
  }
  return Number(estimate);
}

@Injectable()
export class EarnService {
  constructor(
    private readonly creditsRepo: CreditsRepository,
    private readonly programsRepo: ProgramsRepository,
    private readonly issuanceBudget: IssuanceBudgetService,
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
      : await this.estimatePoints(organizationId, request.purchaseAmount, request.idempotencyKey);

    const { transaction, newBalance } = await this.creditsRepo
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

    return toEarnResponse(transaction, newBalance);
  }

  /** Rejects before reserving anything: the chain-submit worker would otherwise fail the earn after it was accepted. */
  private async estimatePoints(
    organizationId: string,
    purchaseAmount: number,
    idempotencyKey: string,
  ): Promise<number> {
    const program = await requireProgramConfig(this.programsRepo, organizationId);
    const estimatedPoints = pointsForPurchase(purchaseAmount, program.earnBps);
    if (!(await this.issuanceBudget.canCover(program, idempotencyKey, estimatedPoints))) {
      throw new UnprocessableEntityException('The issuance budget cannot cover this earn; request a top-up');
    }
    return estimatedPoints;
  }
}
