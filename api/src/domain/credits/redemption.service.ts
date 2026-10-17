import { Injectable, BadRequestException } from '@nestjs/common';
import { CreditsRepository } from '../../infra/db/repositories/credits.repository.js';
import { WebhookDeliveryService } from '../webhooks/webhook-delivery.service.js';
import type { RedeemPointsRequest, RedeemPointsResponse } from '@octap/contracts';

@Injectable()
export class RedemptionService {
  constructor(
    private readonly creditsRepo: CreditsRepository,
    private readonly webhooks: WebhookDeliveryService,
  ) {}

  async executeRedeem(organizationId: string, request: RedeemPointsRequest): Promise<RedeemPointsResponse> {
    if (request.pointsAmount <= 0) {
      throw new BadRequestException('Points amount must be greater than zero');
    }

    const existingTx = await this.creditsRepo.findTransactionByIdempotency(
      organizationId,
      request.idempotencyKey,
    );

    if (existingTx) {
      const ownership = await this.creditsRepo.getOrCreateCreditOwnership(request.organizationEndUserId);
      return {
        transactionId: existingTx.id,
        organizationEndUserId: existingTx.organizationEndUserId,
        pointsRedeemed: existingTx.pointsAmount,
        newBalance: Number(ownership.confirmedBalance),
        status: existingTx.status,
        idempotencyKey: existingTx.idempotencyKey,
      };
    }

    try {
      const { transaction, newBalance } = await this.creditsRepo.recordRedeemTransaction({
        organizationId,
        organizationEndUserId: request.organizationEndUserId,
        pointsAmount: request.pointsAmount,
        idempotencyKey: request.idempotencyKey,
        receiptReference: request.receiptReference,
        metadata: request.metadata,
      });

      await this.webhooks.emit(organizationId, 'credits.redeemed', {
        transactionId: transaction.id,
        organizationEndUserId: transaction.organizationEndUserId,
        pointsAmount: transaction.pointsAmount,
        newBalance,
      });

      return {
        transactionId: transaction.id,
        organizationEndUserId: transaction.organizationEndUserId,
        pointsRedeemed: transaction.pointsAmount,
        newBalance,
        status: transaction.status,
        idempotencyKey: transaction.idempotencyKey,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to redeem points';
      throw new BadRequestException(message);
    }
  }
}
