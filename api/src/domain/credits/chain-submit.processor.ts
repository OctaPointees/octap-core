import { Injectable, Logger } from '@nestjs/common';
import { CreditsRepository } from '../../infra/db/repositories/credits.repository.js';
// Not `import type`: NestJS DI resolves this constructor param by its runtime type (reflect-metadata),
// which an erased type-only import would turn into a bare `Function` and break resolution.
import { OperationsRepository } from '../../infra/db/repositories/operations.repository.js';
import { ProgramsRepository } from '../../infra/db/repositories/programs.repository.js';
import type { operations } from '../../infra/db/schema/operations.schema.js';
import { SuiClientService } from '../../infra/clients/sui/sui.client.js';
import { resolveProgramConfig } from '../programs/program-config.js';

interface EarnChainSubmitPayload {
  loyaltyTransactionId: string;
  organizationEndUserId: string;
  pointsAmount: number;
}

/**
 * `earn()` threw instead of returning a chain verdict (gRPC timeout, connection drop while waiting
 * for the checkpoint, ...): the transaction may or may not have landed. Only a returned
 * `status: 'failure'` is a definitive on-chain failure.
 */
class EarnOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super(`earn outcome unknown: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'EarnOutcomeUnknownError';
  }
}

/** Carries one durable command through its domain services. Lifecycle stays in `chain-submit.worker.ts`. */
@Injectable()
export class ChainSubmitProcessor {
  private readonly logger = new Logger(ChainSubmitProcessor.name);

  constructor(
    private readonly operationsRepo: OperationsRepository,
    private readonly creditsRepo: CreditsRepository,
    private readonly suiClient: SuiClientService,
    private readonly programsRepo: ProgramsRepository,
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
      // The operation's own tenant, never a shared default: an organization without a provisioned
      // program fails here, before anything is sent on-chain.
      const program = await resolveProgramConfig(this.programsRepo, operation.tenantId);

      const ownership = await this.creditsRepo.getCreditOwnershipByEndUserId(payload.organizationEndUserId);
      if (!ownership) {
        throw new Error(`No credit ownership for end user ${payload.organizationEndUserId}`);
      }

      let accountId: string | null | undefined = ownership.suiCreditAccountId;
      if (!accountId) {
        // Real zkLogin address, not a placeholder (OCT-55): `organization_end_users` can only
        // exist via `IdentityService.enrollInOrganization`, which requires a prior Google login,
        // so this is always populated by the time a member can earn at all. Opening the account
        // under anything else would permanently block redeem later (credit_account.move's
        // `beneficiary` field is set once at `open_account` and has no entry point to change it).
        const beneficiaryAddress = await this.creditsRepo.findBeneficiaryAddress(payload.organizationEndUserId);
        if (!beneficiaryAddress) {
          throw new Error(`No real Sui address on file for end user ${payload.organizationEndUserId}`);
        }
        const opened = await this.suiClient.openAccount(program, beneficiaryAddress);
        if (opened.status !== 'success') {
          throw new Error(opened.errorMessage ?? 'open_account failed on-chain');
        }
        accountId = opened.eventField<string>('CreditAccountOpened', 'account_id');
        if (!accountId) {
          throw new Error('open_account did not emit CreditAccountOpened');
        }
        await this.creditsRepo.setSuiCreditAccountId(ownership.id, accountId);
      }

      // The chain treats `pointsAmount` as a purchase amount and credits the program policy's
      // `earn_bps` share of it (see credits.repository.ts's confirmEarnOnChain), not the raw number.
      let result: Awaited<ReturnType<SuiClientService['earn']>>;
      try {
        result = await this.suiClient.earn(program, {
          accountId,
          purchaseAmount: payload.pointsAmount,
          operationKey: operation.idempotencyKey,
        });
      } catch (err: unknown) {
        throw new EarnOutcomeUnknownError(err);
      }

      if (result.status !== 'success') {
        throw new Error(result.errorMessage ?? 'earn failed on-chain');
      }

      const confirmedPointsAmount = result.eventField<string>('CreditEarned', 'amount');
      if (confirmedPointsAmount === undefined) {
        throw new Error('earn succeeded but emitted no CreditEarned event');
      }

      const bucketExpiresAtMs = result.eventField<string>('CreditEarned', 'bucket_expires_at_ms');
      await this.recordLandedEarn(
        operation,
        payload,
        result.digest,
        Number(confirmedPointsAmount),
        bucketExpiresAtMs === undefined ? null : Number(bucketExpiresAtMs),
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof EarnOutcomeUnknownError) {
        // Releasing the hold here could under-credit a member whose earn did land, and a FAILED
        // status invites the merchant to retry under a new key: a second on-chain earn.
        this.logger.error(`earn outcome unknown for operation ${operation.id}; left for the indexer: ${message}`);
        await this.markUnknown(operation.id, message);
        return;
      }
      this.logger.error(`earn chain submit failed for operation ${operation.id}: ${message}`);
      await this.creditsRepo.failEarnOnChain({
        loyaltyTransactionId: payload.loyaltyTransactionId,
        organizationEndUserId: payload.organizationEndUserId,
        reservedPointsAmount: payload.pointsAmount,
      });
      await this.operationsRepo.markFailed(operation.id, message);
    }
  }

  /**
   * The earn already landed on-chain, so a PG error from here on must never reach
   * `failEarnOnChain` — that would release a hold for points the member really has. Instead the
   * row stays PENDING and the operation goes UNKNOWN, and `domain/indexer` confirms it from the
   * `CreditEarned` event.
   */
  private async recordLandedEarn(
    operation: typeof operations.$inferSelect,
    payload: EarnChainSubmitPayload,
    digest: string,
    confirmedPointsAmount: number,
    bucketExpiresAtMs: number | null,
  ): Promise<void> {
    try {
      const confirmed = await this.creditsRepo.confirmEarnOnChain({
        loyaltyTransactionId: payload.loyaltyTransactionId,
        organizationEndUserId: payload.organizationEndUserId,
        reservedPointsAmount: payload.pointsAmount,
        confirmedPointsAmount,
        bucketExpiresAtMs,
        digest,
        sender: this.suiClient.issuerAddress(),
      });
      await this.operationsRepo.markSubmitted(operation.id, digest);
      this.logger.log(
        confirmed
          ? `earn confirmed: tx=${payload.loyaltyTransactionId} digest=${digest}`
          : `earn already confirmed by the indexer: tx=${payload.loyaltyTransactionId} digest=${digest}`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`earn landed (digest=${digest}) but recording it failed; left for the indexer: ${message}`);
      await this.markUnknown(operation.id, message, digest);
    }
  }

  private async markUnknown(operationId: string, message: string, digest?: string): Promise<void> {
    if (!(await this.operationsRepo.markUnknown(operationId, message, digest))) {
      this.logger.warn(`operation ${operationId} was no longer PROCESSING (already settled, likely by the indexer); left as is`);
    }
  }
}
