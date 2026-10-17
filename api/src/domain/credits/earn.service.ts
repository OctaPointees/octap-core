import { Injectable, BadRequestException } from '@nestjs/common';
import { CreditsRepository } from '../../infra/db/repositories/credits.repository.js';
import { WebhookDeliveryService } from '../webhooks/webhook-delivery.service.js';
import type { EarnPointsRequest, EarnPointsResponse } from '@octap/contracts';

@Injectable()
export class EarnService {
  constructor(
    private readonly creditsRepo: CreditsRepository,
    private readonly webhooks: WebhookDeliveryService,
  ) {}

  async executeEarn(organizationId: string, request: EarnPointsRequest): Promise<EarnPointsResponse> {
    if (request.pointsAmount <= 0) {
      throw new BadRequestException('Points amount must be greater than zero');
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
