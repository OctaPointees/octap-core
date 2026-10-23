import { Injectable, Logger } from '@nestjs/common';
import { eventField, type SubmittedChainTransaction } from '@octap/chain';
import { CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import { OperationsRepository } from '#infra/db/repositories/operations.repository.js';
import type { operations } from '#infra/db/schema/operations.schema.js';
import { SuiClientService } from '#infra/clients/sui/sui.client.js';
import { SuiTransactionBuilderClient } from '#infra/clients/sui/sui-transaction-builder.client.js';

export const EARN_COMMAND_TYPE = 'CREDIT_EARN_CHAIN_SUBMIT';
export const POS_REDEEM_COMMAND_TYPE = 'CREDIT_POS_REDEEM_RESERVE';

/** Long enough that a healthy submit (or the indexer) has settled it first; this is the fallback. */
const RECONCILE_AFTER_MS = Number(process.env.CHAIN_OUTCOME_RECONCILE_AFTER_MS ?? 5 * 60 * 1000);
const BATCH_SIZE = Number(process.env.CHAIN_OUTCOME_RECONCILE_BATCH_SIZE ?? 20);

interface EarnPayload {
  loyaltyTransactionId: string;
  organizationEndUserId: string;
  pointsAmount: number;
}

interface PosRedeemPayload {
  organizationEndUserId: string;
  pointsAmount: number;
}

type Operation = typeof operations.$inferSelect;
export type ReconcileOutcome = 'confirmed' | 'failed' | 'waiting';

/**
 * Settles commands whose chain outcome was never learned (OCT-52): an earn whose `execute` threw,
 * a POS finalize whose `executeSponsoredRedeem` (or the wait after it) threw, or a worker that died
 * mid-submit. The digest was persisted before sending, so this asks the chain about exactly that
 * transaction instead of guessing — and never sends anything itself, so it can't cause a second
 * on-chain effect:
 *
 * - found + success -> confirm through the same `confirm*OnChain` the other paths use (a no-op if
 *   the indexer got there first: the PENDING guard)
 * - found + failure -> release the hold, FAILED
 * - not found, chain past the transaction's expiration epoch -> it never landed and never can:
 *   release the hold, FAILED
 * - not found, still within its expiration -> leave it and look again later
 *
 * An earn with no digest at all never had anything sent (the digest is recorded before sending),
 * so it is released straight away.
 */
@Injectable()
export class ChainOutcomeReconciler {
  private readonly logger = new Logger(ChainOutcomeReconciler.name);

  constructor(
    private readonly operationsRepo: OperationsRepository,
    private readonly creditsRepo: CreditsRepository,
    private readonly suiReader: SuiTransactionBuilderClient,
    private readonly suiClient: SuiClientService,
  ) {}

  async reconcileOnce(): Promise<ReconcileOutcome[]> {
    const due = await this.operationsRepo.listUnresolvedChainOutcomes({
      earnCommandType: EARN_COMMAND_TYPE,
      posCommandType: POS_REDEEM_COMMAND_TYPE,
      olderThanMs: RECONCILE_AFTER_MS,
      limit: BATCH_SIZE,
    });
    if (due.length === 0) {
      return [];
    }

    let epoch: bigint | undefined;
    const currentEpoch = async () => (epoch ??= await this.suiReader.currentEpoch());

    const outcomes: ReconcileOutcome[] = [];
    for (const operation of due) {
      try {
        outcomes.push(await this.reconcile(operation, currentEpoch));
      } catch (err: unknown) {
        this.logger.error(
          `reconciling operation ${operation.id} failed, will retry: ${err instanceof Error ? err.message : String(err)}`,
        );
        await this.operationsRepo.touch(operation.id);
        outcomes.push('waiting');
      }
    }
    return outcomes;
  }

  private async reconcile(operation: Operation, currentEpoch: () => Promise<bigint>): Promise<ReconcileOutcome> {
    const isEarn = operation.commandType === EARN_COMMAND_TYPE;

    if (!operation.suiTxDigest) {
      // Only earns get here (POS rows need a digest to be listed): nothing was ever sent.
      return this.fail(operation, 'no transaction was ever sent for this command');
    }

    const outcome = await this.suiReader.findTransaction(operation.suiTxDigest);
    if (outcome?.status === 'success') {
      return isEarn ? this.confirmEarn(operation, outcome) : this.confirmPosRedeem(operation, outcome);
    }
    if (outcome?.status === 'failure') {
      return this.fail(operation, outcome.errorMessage ?? `${operation.suiTxDigest} failed on-chain`);
    }

    const expiration = operation.suiTxExpirationEpoch;
    if (expiration !== null && (await currentEpoch()) > expiration) {
      return this.fail(operation, `${operation.suiTxDigest} never landed and expired after epoch ${expiration}`);
    }
    if (expiration === null) {
      this.logger.warn(
        `${operation.suiTxDigest} (operation ${operation.id}) is not on-chain and has no expiration; needs a human`,
      );
    }
    await this.operationsRepo.touch(operation.id);
    return 'waiting';
  }

  private async confirmEarn(operation: Operation, outcome: SubmittedChainTransaction): Promise<ReconcileOutcome> {
    const payload = operation.payload as unknown as EarnPayload;
    const amount = eventField<string>(outcome, 'CreditEarned', 'amount');
    if (amount === undefined) {
      this.logger.error(
        `${outcome.digest} succeeded but emitted no CreditEarned; operation ${operation.id} left for a human`,
      );
      await this.operationsRepo.touch(operation.id);
      return 'waiting';
    }
    const bucketExpiresAtMs = eventField<string>(outcome, 'CreditEarned', 'bucket_expires_at_ms');

    await this.creditsRepo.confirmEarnOnChain({
      loyaltyTransactionId: payload.loyaltyTransactionId,
      organizationEndUserId: payload.organizationEndUserId,
      reservedPointsAmount: payload.pointsAmount,
      confirmedPointsAmount: Number(amount),
      bucketExpiresAtMs: bucketExpiresAtMs === undefined ? null : Number(bucketExpiresAtMs),
      digest: outcome.digest,
      sender: this.suiClient.issuerAddress(),
    });
    await this.operationsRepo.settleFromChain(operation.id, 'SUBMITTED');
    this.logger.log(`earn ${payload.loyaltyTransactionId} confirmed from digest ${outcome.digest}`);
    return 'confirmed';
  }

  private async confirmPosRedeem(operation: Operation, outcome: SubmittedChainTransaction): Promise<ReconcileOutcome> {
    const payload = operation.payload as unknown as PosRedeemPayload;
    const loyaltyTx = await this.creditsRepo.findTransactionByIdempotency(operation.tenantId, operation.idempotencyKey);
    const sender = await this.creditsRepo.findBeneficiaryAddress(payload.organizationEndUserId);
    if (!loyaltyTx || !sender) {
      this.logger.error(`operation ${operation.id} has no loyalty transaction or beneficiary; left for a human`);
      await this.operationsRepo.touch(operation.id);
      return 'waiting';
    }

    await this.creditsRepo.confirmPosRedemptionOnChain({
      loyaltyTransactionId: loyaltyTx.id,
      organizationEndUserId: payload.organizationEndUserId,
      pointsAmount: payload.pointsAmount,
      digest: outcome.digest,
      sender,
    });
    await this.operationsRepo.settleFromChain(operation.id, 'SUBMITTED');
    this.logger.log(`POS redemption ${loyaltyTx.id} confirmed from digest ${outcome.digest}`);
    return 'confirmed';
  }

  private async fail(operation: Operation, reason: string): Promise<ReconcileOutcome> {
    if (operation.commandType === EARN_COMMAND_TYPE) {
      const payload = operation.payload as unknown as EarnPayload;
      await this.creditsRepo.failEarnOnChain({
        loyaltyTransactionId: payload.loyaltyTransactionId,
        organizationEndUserId: payload.organizationEndUserId,
        reservedPointsAmount: payload.pointsAmount,
      });
    } else {
      const payload = operation.payload as unknown as PosRedeemPayload;
      const loyaltyTx = await this.creditsRepo.findTransactionByIdempotency(
        operation.tenantId,
        operation.idempotencyKey,
      );
      if (loyaltyTx) {
        await this.creditsRepo.failPosRedemptionOnChain({
          loyaltyTransactionId: loyaltyTx.id,
          organizationEndUserId: payload.organizationEndUserId,
          pointsAmount: payload.pointsAmount,
        });
      }
    }
    await this.operationsRepo.settleFromChain(operation.id, 'FAILED', reason);
    this.logger.warn(`operation ${operation.id} failed by reconciliation: ${reason}`);
    return 'failed';
  }
}
