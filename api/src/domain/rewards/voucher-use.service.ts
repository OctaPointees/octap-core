import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  type HttpException,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { transactionExpirationEpoch } from '@octap/chain';
import type {
  FinalizeVoucherUseRequest,
  PrepareVoucherUseRequest,
  PrepareVoucherUseResponse,
  RedeemVoucherResponse,
} from '@octap/contracts';
import { REDIS_CLIENT } from '#infra/cache/redis.provider.js';
import { CreditsRepository, voucherClaimReference } from '#infra/db/repositories/credits.repository.js';
import { OperationPayloadConflictError, OperationsRepository } from '#infra/db/repositories/operations.repository.js';
import { RewardsRepository, RewardsRuleError } from '#infra/db/repositories/rewards.repository.js';
import { RESERVE_TTL_SECONDS } from '../credits/pos-redemption.service.js';
import { mapMemberEligibilityError } from '../credits/member-eligibility-error.js';
import { SponsoredTransactionService } from '../identity/sponsored-transaction.service.js';
import { SuiTransactionBuilderClient } from '#infra/clients/sui/sui-transaction-builder.client.js';

interface CachedUse {
  organizationId: string;
  organizationEndUserId: string;
  voucherOwnershipId: string;
  operationId: string;
  idempotencyKey: string;
  transactionBytes: string;
}

type Prepared = Awaited<ReturnType<RewardsRepository['reserveVoucherUse']>>;

const useKey = (digest: string) => `voucher-use:reserve:${digest}`;
const useIdemKey = (organizationId: string, idempotencyKey: string) =>
  `voucher-use:idem:${organizationId}:${idempotencyKey}`;

function expirationOf(transactionBytes: string): bigint | null {
  try {
    return transactionExpirationEpoch(transactionBytes);
  } catch {
    return null;
  }
}

function toHttpError(error: unknown): unknown {
  if (error instanceof RewardsRuleError) {
    if (error.kind === 'NOT_FOUND') return new NotFoundException(error.message);
    if (error.kind === 'CONFLICT') return new ConflictException(error.message);
    return new BadRequestException(error.message);
  }
  if (error instanceof OperationPayloadConflictError) return new ConflictException(error.message);
  return mapMemberEligibilityError(error) as HttpException;
}

/**
 * Customer-signed voucher use. A merchant's API key can only ask: `prepare` returns bytes for the
 * customer's device, and only their signature lets `credit_account::use_voucher` mark the voucher used.
 * Same digest-first lifecycle as `PosRedemptionService`, and the indexer and `ChainOutcomeReconciler`
 * settle it the same way if the answer here is lost.
 */
@Injectable()
export class VoucherUseService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly rewardsRepo: RewardsRepository,
    private readonly creditsRepo: CreditsRepository,
    private readonly operationsRepo: OperationsRepository,
    private readonly sponsoredTx: SponsoredTransactionService,
    private readonly suiBuilder: SuiTransactionBuilderClient,
  ) {}

  async prepare(organizationId: string, request: PrepareVoucherUseRequest): Promise<PrepareVoucherUseResponse> {
    if (typeof request.serialCode !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(request.serialCode)) {
      throw new BadRequestException('serialCode must contain 1-100 letters, numbers, underscores or hyphens');
    }
    if (typeof request.idempotencyKey !== 'string' || !/^[a-zA-Z0-9:_-]{1,100}$/.test(request.idempotencyKey)) {
      throw new BadRequestException(
        'idempotencyKey must contain 1-100 letters, numbers, colons, underscores or hyphens',
      );
    }

    let prepared: Prepared;
    try {
      prepared = await this.rewardsRepo.reserveVoucherUse({
        organizationId,
        serialCode: request.serialCode,
        idempotencyKey: request.idempotencyKey,
      });
    } catch (error) {
      throw toHttpError(error);
    }

    const { ownership, voucher, operation, isNew } = prepared;
    const respond = (digest: string | null, transactionBytes: string | null): PrepareVoucherUseResponse => ({
      voucherOwnershipId: ownership.id,
      voucherId: ownership.voucherId,
      serialCode: ownership.serialCode,
      status: ownership.status,
      digest,
      transactionBytes,
      voucherTitle: voucher.title,
      discountType: voucher.discountType,
      discountValue: voucher.discountValue,
    });

    if (!['PENDING', 'UNKNOWN'].includes(operation.status)) return respond(null, null);

    if (!isNew) {
      const cachedDigest = await this.redis.get(useIdemKey(organizationId, request.idempotencyKey));
      const cachedRaw = cachedDigest ? await this.redis.get(useKey(cachedDigest)) : null;
      if (cachedDigest && cachedRaw) {
        return respond(cachedDigest, (JSON.parse(cachedRaw) as CachedUse).transactionBytes);
      }
      if (operation.suiTxDigest) {
        // Fresh bytes could not land twice, but they would hide the outcome of the first attempt.
        throw new ConflictException(
          `A use of this voucher (${operation.suiTxDigest}) is still being resolved on-chain; try again later`,
        );
      }
    }

    const beneficiaryAddress = await this.creditsRepo.findBeneficiaryAddress(ownership.organizationEndUserId);
    const account = await this.creditsRepo.getCreditOwnershipByEndUserId(ownership.organizationEndUserId);
    if (!beneficiaryAddress || !account?.suiCreditAccountId || !voucher.suiTermsId) {
      throw new BadRequestException('This voucher has no on-chain record to use');
    }

    const sponsored = await this.sponsoredTx.previewSponsoredUseVoucher({
      beneficiaryAddress,
      accountId: account.suiCreditAccountId,
      termsId: voucher.suiTermsId,
      reference: new TextEncoder().encode(voucherClaimReference(ownership.id)),
    });

    const entry: CachedUse = {
      organizationId,
      organizationEndUserId: ownership.organizationEndUserId,
      voucherOwnershipId: ownership.id,
      operationId: operation.id,
      idempotencyKey: request.idempotencyKey,
      transactionBytes: sponsored.transactionBytes,
    };
    await this.redis.set(useKey(sponsored.digest), JSON.stringify(entry), 'EX', RESERVE_TTL_SECONDS);
    await this.redis.set(
      useIdemKey(organizationId, request.idempotencyKey),
      sponsored.digest,
      'EX',
      RESERVE_TTL_SECONDS,
    );
    return respond(sponsored.digest, sponsored.transactionBytes);
  }

  async finalize(request: FinalizeVoucherUseRequest): Promise<RedeemVoucherResponse> {
    const raw = await this.redis.get(useKey(request.digest));
    if (!raw) throw new NotFoundException('This voucher use was not found or expired; prepare it again');
    const cached = JSON.parse(raw) as CachedUse;

    // Recorded before executing, so a lost answer below is settled by asking the chain about it.
    const operationId = await this.operationsRepo.recordSubmitDigestForCommand({
      tenantId: cached.organizationId,
      idempotencyKey: cached.idempotencyKey,
      suiTxDigest: request.digest,
      expirationEpoch: expirationOf(cached.transactionBytes),
    });
    if (!operationId) {
      await this.redis.del(useKey(request.digest));
      throw new ConflictException('This voucher use is settled or another digest is already being resolved');
    }

    let executed: { digest: string };
    try {
      executed = await this.sponsoredTx.executeSponsoredRedeem({
        digest: request.digest,
        signature: request.signature,
      });
    } catch (error) {
      // A bad signature is retryable with a fixed one; nothing is released.
      throw new BadRequestException(error instanceof Error ? error.message : 'Enoki execute failed');
    }

    const result = await this.suiBuilder.waitForTransaction(executed.digest);
    if (result.status !== 'success') {
      await this.rewardsRepo.failVoucherUse({ operationId, voucherOwnershipId: cached.voucherOwnershipId });
      await this.operationsRepo.settleFromChain(operationId, 'FAILED', result.errorMessage ?? 'use failed on-chain');
      await this.redis.del(useKey(request.digest));
      throw new BadRequestException(result.errorMessage ?? 'Voucher use failed on-chain');
    }

    const confirmed = await this.rewardsRepo.confirmVoucherUse({
      voucherOwnershipId: cached.voucherOwnershipId,
      digest: result.digest,
    });
    await this.operationsRepo.settleFromChain(operationId, 'SUBMITTED');
    await this.redis.del(useKey(request.digest));
    if (!confirmed) throw new ConflictException('The chain recorded this use, but the voucher here has another status');

    const { ownership, voucher } = confirmed;
    return {
      voucherOwnershipId: ownership.id,
      voucherId: ownership.voucherId,
      serialCode: ownership.serialCode,
      status: ownership.status,
      redeemedAt: ownership.redeemedAt!.toISOString(),
      voucherTitle: voucher.title,
      discountType: voucher.discountType,
      discountValue: voucher.discountValue,
      blockchainDigest: result.digest,
    };
  }
}
