import { Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CreditsRepository } from '../../infra/db/repositories/credits.repository.js';
import type { ReverseTransactionRequest, ReverseTransactionResponse } from '@octap/contracts';

@Injectable()
export class ReversalService {
  constructor(private readonly creditsRepo: CreditsRepository) {}

  async reverseTransaction(
    organizationId: string,
    request: ReverseTransactionRequest,
  ): Promise<ReverseTransactionResponse> {
    const existingByIdempotency = await this.creditsRepo.findTransactionByIdempotency(
      organizationId,
      request.idempotencyKey,
    );
    if (existingByIdempotency) {
      if (existingByIdempotency.transactionType !== 'REVERSAL' || !existingByIdempotency.reversesTransactionId) {
        throw new ConflictException('This idempotency key was already used for a different operation');
      }
      const ownership = await this.creditsRepo.getOrCreateCreditOwnership(
        existingByIdempotency.organizationEndUserId,
      );
      const newBalance = Number(ownership.confirmedBalance);
      return {
        reversalTransactionId: existingByIdempotency.id,
        reversedTransactionId: existingByIdempotency.reversesTransactionId,
        organizationEndUserId: existingByIdempotency.organizationEndUserId,
        pointsAmount: Number(existingByIdempotency.pointsAmount),
        newBalance,
        balanceWentNegative: newBalance < 0,
        idempotencyKey: existingByIdempotency.idempotencyKey,
      };
    }

    if (!request.reason?.trim()) {
      throw new BadRequestException('A reason is required to reverse a transaction');
    }

    const original = await this.creditsRepo.findTransactionByIdForOrganization(
      organizationId,
      request.transactionId,
    );
    if (!original) {
      throw new NotFoundException(`Transaction ${request.transactionId} was not found for this organization`);
    }
    if (original.transactionType !== 'EARN' && original.transactionType !== 'REDEEM') {
      throw new BadRequestException(`Transactions of type ${original.transactionType} cannot be reversed`);
    }
    if (original.status !== 'CONFIRMED') {
      throw new BadRequestException(
        original.status === 'REVERSED'
          ? 'This transaction has already been reversed'
          : `Only a CONFIRMED transaction can be reversed (current status: ${original.status})`,
      );
    }

    try {
      const { reversal, newBalance } = await this.creditsRepo.recordReversalTransaction({
        organizationId,
        original,
        idempotencyKey: request.idempotencyKey,
        reason: request.reason,
      });

      return {
        reversalTransactionId: reversal.id,
        reversedTransactionId: original.id,
        organizationEndUserId: original.organizationEndUserId,
        pointsAmount: Number(reversal.pointsAmount),
        newBalance,
        balanceWentNegative: newBalance < 0,
        idempotencyKey: reversal.idempotencyKey,
      };
    } catch (err: unknown) {
      // Most likely cause: a concurrent reversal of the same original already won the race
      // against the unique index on reverses_transaction_id.
      const message = err instanceof Error ? err.message : 'Failed to reverse transaction';
      throw new ConflictException(message);
    }
  }
}
