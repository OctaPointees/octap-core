import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CreditsRepository } from '../../infra/db/repositories/credits.repository.js';
// Not `import type`: NestJS DI resolves this constructor param by its runtime type (reflect-metadata),
// which an erased type-only import would turn into a bare `Function` and break resolution.
import { OperationsRepository } from '../../infra/db/repositories/operations.repository.js';
import type { operations } from '../../infra/db/schema/operations.schema.js';
import { SuiClientService } from '../../infra/clients/sui/sui.client.js';

interface EarnChainSubmitPayload {
  loyaltyTransactionId: string;
  organizationEndUserId: string;
  pointsAmount: number;
}

/**
 * No zkLogin/identity-binding yet (docs/roadmap.md "Identity"), so an end user has no real Sui
 * address to open a `CreditAccount` under. Derives a stable, syntactically valid placeholder from
 * the ownership row id instead — nobody holds its private key, which is fine for `earn` (no
 * beneficiary signature required) and exactly why `redeem` is NOT wired to this path (see
 * `sui.client.ts`). Replace with the end user's real zkLogin address once that exists; this must
 * not be mistaken for a production identity mapping.
 */
function demoBeneficiaryAddress(ownershipId: string): string {
  return `0x${createHash('sha256').update(ownershipId).digest('hex')}`;
}

/** Carries one durable command through its domain services. Lifecycle stays in `chain-submit.worker.ts`. */
@Injectable()
export class ChainSubmitProcessor {
  private readonly logger = new Logger(ChainSubmitProcessor.name);

  constructor(
    private readonly operationsRepo: OperationsRepository,
    private readonly creditsRepo: CreditsRepository,
    private readonly suiClient: SuiClientService,
  ) {}

  async process(operation: typeof operations.$inferSelect): Promise<void> {
    if (operation.commandType !== 'CREDIT_EARN_CHAIN_SUBMIT') {
      await this.operationsRepo.markFailed(operation.id, `Unsupported commandType "${operation.commandType}"`);
      return;
    }

    await this.processEarn(operation, operation.payload as unknown as EarnChainSubmitPayload);
  }

  private async processEarn(operation: typeof operations.$inferSelect, payload: EarnChainSubmitPayload): Promise<void> {
    try {
      const ownership = await this.creditsRepo.getCreditOwnershipByEndUserId(payload.organizationEndUserId);
      if (!ownership) {
        throw new Error(`No credit ownership for end user ${payload.organizationEndUserId}`);
      }

      let accountId: string | null | undefined = ownership.suiCreditAccountId;
      if (!accountId) {
        const opened = await this.suiClient.openAccount(demoBeneficiaryAddress(ownership.id));
        if (opened.status !== 'success') {
          throw new Error(opened.errorMessage ?? 'open_account failed on-chain');
        }
        accountId = opened.eventField<string>('CreditAccountOpened', 'account_id');
        if (!accountId) {
          throw new Error('open_account did not emit CreditAccountOpened');
        }
        await this.creditsRepo.setSuiCreditAccountId(ownership.id, accountId);
      }

      // Demo policy is 100 bps: the chain treats `pointsAmount` as a purchase amount and credits
      // 1% of it (see docs in credits.repository.ts's confirmEarnOnChain), not the raw number.
      const result = await this.suiClient.earn({
        accountId,
        purchaseAmount: payload.pointsAmount,
        operationKey: operation.idempotencyKey,
      });

      if (result.status !== 'success') {
        throw new Error(result.errorMessage ?? 'earn failed on-chain');
      }

      const confirmedPointsAmount = result.eventField<string>('CreditEarned', 'amount');
      if (confirmedPointsAmount === undefined) {
        throw new Error('earn succeeded but emitted no CreditEarned event');
      }

      await this.creditsRepo.confirmEarnOnChain({
        loyaltyTransactionId: payload.loyaltyTransactionId,
        organizationEndUserId: payload.organizationEndUserId,
        reservedPointsAmount: payload.pointsAmount,
        confirmedPointsAmount: Number(confirmedPointsAmount),
        digest: result.digest,
        sender: this.suiClient.issuerAddress(),
      });
      await this.operationsRepo.markSubmitted(operation.id, result.digest);
      this.logger.log(`earn confirmed: tx=${payload.loyaltyTransactionId} digest=${result.digest}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`earn chain submit failed for operation ${operation.id}: ${message}`);
      await this.creditsRepo.failEarnOnChain({
        loyaltyTransactionId: payload.loyaltyTransactionId,
        organizationEndUserId: payload.organizationEndUserId,
        reservedPointsAmount: payload.pointsAmount,
      });
      await this.operationsRepo.markFailed(operation.id, message);
    }
  }
}
