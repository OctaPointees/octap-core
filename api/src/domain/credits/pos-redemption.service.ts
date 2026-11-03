import { Inject, Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '#infra/cache/redis.provider.js';
import { CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import { ProgramsRepository } from '#infra/db/repositories/programs.repository.js';
import { OperationPayloadConflictError, OperationsRepository } from '#infra/db/repositories/operations.repository.js';
import { SponsoredTransactionService } from '../identity/sponsored-transaction.service.js';
import { SuiTransactionBuilderClient } from '#infra/clients/sui/sui-transaction-builder.client.js';
import { requireProgramConfig } from '../programs/program-config.js';
import { MemberEligibilityError } from '#infra/db/repositories/member-eligibility.js';
import { mapMemberEligibilityError } from './member-eligibility-error.js';
import { transactionExpirationEpoch } from '@octap/chain';
import type {
  ReservePosRedemptionRequest,
  ReservePosRedemptionResponse,
  FinalizePosRedemptionRequest,
  FinalizePosRedemptionResponse,
} from '@octap/contracts';

/**
 * How long a sponsored digest stays redeemable before the caller must reserve again. Must stay
 * below `CreditsRepository`'s `ABANDONED_POS_HOLD_GRACE_MS` (see `releaseAbandonedPosHolds`).
 */
export const RESERVE_TTL_SECONDS = 600;

interface CachedReserve {
  organizationId: string;
  organizationEndUserId: string;
  loyaltyTransactionId: string;
  idempotencyKey: string;
  pointsAmount: number;
  transactionBytes: string;
}

/** postgres-js reports `code` directly; drizzle wraps it in an error whose `cause` carries it. */
function isUniqueViolation(err: unknown): boolean {
  const code = (e: unknown) => (e as { code?: unknown } | null)?.code;
  return code(err) === '23505' || code((err as { cause?: unknown } | null)?.cause) === '23505';
}

/** Unparseable bytes only cost the "expired, never landed" shortcut, never the finalize itself. */
function expirationOf(transactionBytes: string): bigint | null {
  try {
    return transactionExpirationEpoch(transactionBytes);
  } catch {
    return null;
  }
}

type ReservedHold = Awaited<ReturnType<CreditsRepository['reservePosRedemption']>>;

const reserveKey = (digest: string): string => `pos-redeem:reserve:${digest}`;
const idemKey = (organizationId: string, idempotencyKey: string): string =>
  `pos-redeem:idem:${organizationId}:${idempotencyKey}`;

/**
 * Customer-signed on-chain redemption shared by POS and paid voucher claims.
 * RewardsRepository reserves points and stock atomically, then calls sponsorReservation;
 * both channels use finalize and the same indexer/reconciler settlement methods.
 *
 * Two calls, not one, because the chain's own gas-sponsorship lifecycle has a signing step in
 * between that belongs to the customer's device, not this process:
 *
 * - `reserve()`: validates and holds the amount in `pendingRedemption` (not `confirmedBalance`
 *   yet), builds and sponsors the transaction via `SponsoredTransactionService`, and caches the
 *   resulting digest in Redis — Enoki's digest is short-lived, so this process is the only place
 *   that remembers what it was for. Idempotent via `CreditsRepository.reservePosRedemption`
 *   (OCT-43's `acceptCommand`): a repeated key+payload replays the same hold instead of a second
 *   one; a changed payload under a reused key is a conflict.
 * - `finalize()`: takes the customer's signature over that digest, executes it through Enoki,
 *   reads the chain's own verdict, and only then moves the hold into `confirmedBalance` (success)
 *   or releases it (definitive on-chain failure) — never both, never neither.
 */
@Injectable()
export class PosRedemptionService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly creditsRepo: CreditsRepository,
    private readonly sponsoredTx: SponsoredTransactionService,
    private readonly suiBuilder: SuiTransactionBuilderClient,
    private readonly programsRepo: ProgramsRepository,
    private readonly operationsRepo: OperationsRepository,
  ) {}

  async reserve(organizationId: string, request: ReservePosRedemptionRequest): Promise<ReservePosRedemptionResponse> {
    if (request.pointsAmount <= 0) {
      throw new BadRequestException('Points amount must be greater than zero');
    }

    const memberOrgId = await this.creditsRepo.findMemberOrganizationId(request.organizationEndUserId);
    if (memberOrgId !== organizationId) {
      throw new NotFoundException(`Member ${request.organizationEndUserId} was not found for this organization`);
    }

    // Same gate as earn, checked before anything is held. `credit_account::redeem` itself needs no
    // program ids — the member's `CreditAccount` was opened in (and records) its organization's
    // program — so there is nothing further to resolve, only to refuse an unprovisioned one.
    await requireProgramConfig(this.programsRepo, organizationId);

    let reserved: ReservedHold;
    try {
      reserved = await this.creditsRepo.reservePosRedemption({
        organizationId,
        organizationEndUserId: request.organizationEndUserId,
        pointsAmount: request.pointsAmount,
        idempotencyKey: request.idempotencyKey,
      });
    } catch (err: unknown) {
      if (err instanceof MemberEligibilityError) throw mapMemberEligibilityError(err);
      if (err instanceof OperationPayloadConflictError) {
        throw new ConflictException(err.message);
      }
      throw new BadRequestException(err instanceof Error ? err.message : 'Failed to reserve redemption');
    }

    return this.sponsorReservation(organizationId, request, reserved);
  }

  /**
   * Sponsors the customer-signable redeem for an existing hold, or replays the bytes still cached
   * for it. The on-chain `reference` is the hold's receipt reference (a voucher claim's
   * `voucherClaimReference`), else its transaction id.
   */
  async sponsorReservation(
    organizationId: string,
    request: ReservePosRedemptionRequest,
    hold: {
      transaction: ReservedHold['transaction'];
      accountId: string | null;
      /** Digest a finalize already tried to execute for this hold (OCT-52), if any. */
      submittedDigest: string | null;
      /** A hold this request just created has no cached bytes to replay yet. */
      isNew?: boolean;
    },
  ): Promise<ReservePosRedemptionResponse> {
    const { transaction, accountId, isNew, submittedDigest } = hold;

    if (transaction.status !== 'PENDING') {
      // Settled by an earlier call under this idempotency key (CONFIRMED or FAILED) — nothing
      // left to sign.
      return {
        transactionId: transaction.id,
        digest: null,
        transactionBytes: null,
        status: transaction.status,
        idempotencyKey: transaction.idempotencyKey,
      };
    }

    if (!isNew) {
      const cachedDigest = await this.redis.get(idemKey(organizationId, request.idempotencyKey));
      if (cachedDigest) {
        const cachedRaw = await this.redis.get(reserveKey(cachedDigest));
        if (cachedRaw) {
          const cached = JSON.parse(cachedRaw) as CachedReserve;
          return {
            transactionId: transaction.id,
            digest: cachedDigest,
            transactionBytes: cached.transactionBytes,
            status: 'PENDING',
            idempotencyKey: transaction.idempotencyKey,
          };
        }
      }
      if (submittedDigest) {
        // A finalize already sent bytes for this hold and their outcome is still unknown. Fresh
        // bytes could land as a second on-chain redeem; `ChainOutcomeReconciler` settles the
        // first one by digest, and only then is this key reusable.
        throw new ConflictException(
          `A finalize for this redemption (${submittedDigest}) is still being resolved on-chain; try again later`,
        );
      }
      // Cache lapsed: fall through and sponsor fresh bytes for the same existing hold, rather
      // than failing a retry just because the TTL won a race with the customer's device.
    }

    if (!accountId) {
      throw new BadRequestException(`Member ${request.organizationEndUserId} has no on-chain CreditAccount yet`);
    }
    const beneficiaryAddress = await this.creditsRepo.findBeneficiaryAddress(request.organizationEndUserId);
    if (!beneficiaryAddress) {
      throw new BadRequestException(`Member ${request.organizationEndUserId} has no linked Sui address yet`);
    }

    const sponsored = await this.sponsoredTx.previewSponsoredRedeem({
      beneficiaryAddress,
      accountId,
      cost: BigInt(request.pointsAmount),
      reference: new TextEncoder().encode(transaction.receiptReference ?? transaction.id),
    });

    const entry: CachedReserve = {
      organizationId,
      organizationEndUserId: request.organizationEndUserId,
      loyaltyTransactionId: transaction.id,
      idempotencyKey: transaction.idempotencyKey,
      pointsAmount: request.pointsAmount,
      transactionBytes: sponsored.transactionBytes,
    };
    await this.redis.set(reserveKey(sponsored.digest), JSON.stringify(entry), 'EX', RESERVE_TTL_SECONDS);
    await this.redis.set(idemKey(organizationId, request.idempotencyKey), sponsored.digest, 'EX', RESERVE_TTL_SECONDS);

    return {
      transactionId: transaction.id,
      digest: sponsored.digest,
      transactionBytes: sponsored.transactionBytes,
      status: 'PENDING',
      idempotencyKey: transaction.idempotencyKey,
    };
  }

  async finalize(request: FinalizePosRedemptionRequest): Promise<FinalizePosRedemptionResponse> {
    const raw = await this.redis.get(reserveKey(request.digest));
    if (!raw) {
      throw new NotFoundException('Reserved redemption not found or expired; reserve again');
    }
    const cached = JSON.parse(raw) as CachedReserve;
    // Same precondition reserve() enforced; checked before executing so a missing address fails
    // loudly with no chain effect, instead of being papered over in the receipt.
    const beneficiaryAddress = await this.creditsRepo.findBeneficiaryAddress(cached.organizationEndUserId);
    if (!beneficiaryAddress) {
      throw new BadRequestException(`No real Sui address on file for member ${cached.organizationEndUserId}`);
    }

    // Recorded before executing (OCT-52): if Enoki's execute or the wait below throws, the outcome
    // is unknown, and `ChainOutcomeReconciler` settles this hold by asking the chain about this
    // digest — confirmed, failed, or expired without ever landing.
    const operationId = await this.operationsRepo.recordSubmitDigestForCommand({
      tenantId: cached.organizationId,
      idempotencyKey: cached.idempotencyKey,
      suiTxDigest: request.digest,
      expirationEpoch: expirationOf(cached.transactionBytes),
    });
    if (!operationId) {
      // The command is already settled. If that was its hold being released (abandoned, or failed),
      // executing now would spend on-chain points with no hold left to confirm against.
      const hold = await this.creditsRepo.findTransactionByIdForOrganization(
        cached.organizationId,
        cached.loyaltyTransactionId,
      );
      if (hold?.status === 'FAILED') {
        await this.redis.del(reserveKey(request.digest));
        throw new ConflictException('This reserved redemption was released; reserve again');
      }
    }

    if (!operationId) throw new ConflictException('Redemption is settled or another digest is already being resolved');

    let executed: { digest: string };
    try {
      executed = await this.sponsoredTx.executeSponsoredRedeem({
        digest: request.digest,
        signature: request.signature,
      });
    } catch (err: unknown) {
      // Reservation and cache stay in place: a bad/stale signature is retryable with a fixed one,
      // not a reason to release the hold or force the caller back through /reserve.
      throw new BadRequestException(err instanceof Error ? err.message : 'Enoki execute failed');
    }

    const result = await this.suiBuilder.waitForTransaction(executed.digest);

    if (result.status !== 'success') {
      await this.creditsRepo.failPosRedemptionOnChain({
        loyaltyTransactionId: cached.loyaltyTransactionId,
        organizationEndUserId: cached.organizationEndUserId,
        pointsAmount: cached.pointsAmount,
      });
      if (operationId) {
        await this.operationsRepo.settleFromChain(
          operationId,
          'FAILED',
          result.errorMessage ?? 'redeem failed on-chain',
        );
      }
      await this.redis.del(reserveKey(request.digest));
      throw new BadRequestException(result.errorMessage ?? 'Redeem failed on-chain');
    }

    // Null means `domain/indexer` saw this redeem's event and confirmed it first — same digest,
    // same outcome, so the response below is unchanged. Whichever side confirms queues the
    // `credits.redemption.confirmed` webhook inside the confirm itself (OCT-209), so there is
    // nothing to emit from here.
    try {
      await this.creditsRepo.confirmPosRedemptionOnChain({
        loyaltyTransactionId: cached.loyaltyTransactionId,
        organizationEndUserId: cached.organizationEndUserId,
        pointsAmount: cached.pointsAmount,
        digest: result.digest,
        sender: beneficiaryAddress,
      });
    } catch (err: unknown) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
      // A concurrent finalize of this same digest (client retry) recorded it first: same
      // outcome, so answer the retry the same way instead of a 500.
      const ownership = await this.creditsRepo.getOrCreateCreditOwnership(cached.organizationEndUserId);
      return this.confirmedResponse(cached, Number(ownership.confirmedBalance), result.digest);
    }

    if (operationId) {
      await this.operationsRepo.settleFromChain(operationId, 'SUBMITTED');
    }
    await this.redis.del(reserveKey(request.digest));

    const ownership = await this.creditsRepo.getOrCreateCreditOwnership(cached.organizationEndUserId);
    return this.confirmedResponse(cached, Number(ownership.confirmedBalance), result.digest);
  }

  private confirmedResponse(cached: CachedReserve, newBalance: number, digest: string): FinalizePosRedemptionResponse {
    return {
      transactionId: cached.loyaltyTransactionId,
      organizationEndUserId: cached.organizationEndUserId,
      pointsRedeemed: cached.pointsAmount,
      newBalance,
      status: 'CONFIRMED',
      blockchainDigest: digest,
    };
  }
}
