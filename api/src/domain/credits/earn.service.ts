import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { CreditsRepository } from '../../infra/db/repositories/credits.repository.js';
import { ProgramsRepository } from '../../infra/db/repositories/programs.repository.js';
import { WebhookDeliveryService } from '../webhooks/webhook-delivery.service.js';
import { requireProgramConfig } from '../programs/program-config.js';
import type { EarnPointsRequest, EarnPointsResponse } from '@octap/contracts';

@Injectable()
export class EarnService {
  constructor(
    private readonly creditsRepo: CreditsRepository,
    private readonly webhooks: WebhookDeliveryService,
    private readonly programsRepo: ProgramsRepository,
  ) {}

  async executeEarn(organizationId: string, request: EarnPointsRequest): Promise<EarnPointsResponse> {
    if (request.pointsAmount <= 0) {
      throw new BadRequestException('Points amount must be greater than zero');
    }

    const memberOrgId = await this.creditsRepo.findMemberOrganizationId(request.organizationEndUserId);
    if (memberOrgId !== organizationId) {
      throw new NotFoundException(`Member ${request.organizationEndUserId} was not found for this organization`);
    }

    // Check idempotency
    const existingTx = await this.creditsRepo.findTransactionByIdempotency(
      organizationId,
      request.idempotencyKey,
    );

    if (existingTx) {
      const ownership = await this.creditsRepo.getOrCreateCreditOwnership(request.organizationEndUserId);
      return {
        transactionId: existingTx.id,
        organizationEndUserId: existingTx.organizationEndUserId,
        pointsEarned: existingTx.pointsAmount,
        newBalance: Number(ownership.confirmedBalance),
        status: existingTx.status,
        idempotencyKey: existingTx.idempotencyKey,
      };
    }

    // Reject before reserving anything: the chain-submit worker would otherwise fail the earn
    // asynchronously, after the client was already told it was accepted.
    await requireProgramConfig(this.programsRepo, organizationId);

    const { transaction, newBalance } = await this.creditsRepo.recordEarnTransaction({
      organizationId,
      organizationEndUserId: request.organizationEndUserId,
      pointsAmount: request.pointsAmount,
      idempotencyKey: request.idempotencyKey,
      receiptReference: request.receiptReference,
      metadata: request.metadata,
    });

    await this.webhooks.emit(organizationId, 'credits.earned', {
      transactionId: transaction.id,
      organizationEndUserId: transaction.organizationEndUserId,
      pointsAmount: transaction.pointsAmount,
      newBalance,
    });

    return {
      transactionId: transaction.id,
      organizationEndUserId: transaction.organizationEndUserId,
      pointsEarned: transaction.pointsAmount,
      newBalance,
      status: transaction.status,
      idempotencyKey: transaction.idempotencyKey,
    };
  }
}
