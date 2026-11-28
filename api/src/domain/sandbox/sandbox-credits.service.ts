import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreditBalanceSnapshot,
  EarnPointsRequest,
  EarnPointsResponse,
  FinalizePosRedemptionRequest,
  FinalizePosRedemptionResponse,
  LoyaltyTransactionDto,
  LoyaltyTransactionPage,
  ReservePosRedemptionRequest,
  ReservePosRedemptionResponse,
} from '@octap/contracts';
import type { TenantContext } from '#infra/auth/tenant-context.js';
import { CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import { OperationPayloadConflictError } from '#infra/db/repositories/operations.repository.js';
import { ProgramsRepository } from '#infra/db/repositories/programs.repository.js';
import {
  SandboxHoldReleasedError,
  SandboxInsufficientPointsError,
  SandboxRepository,
  type SandboxBalance,
  type SandboxTransaction,
} from '#infra/db/repositories/sandbox.repository.js';
import { UUID_PATTERN } from '#infra/db/repositories/console-access.js';
import { requireProgramConfig } from '../programs/program-config.js';
import { pointsForPurchase } from '../credits/earn.service.js';
import { campaignBoost } from '../credits/campaign-boost.js';
import { CampaignsRepository } from '#infra/db/repositories/campaigns.repository.js';
import { assertValidReserveRequest } from '../credits/pos-redemption.service.js';
import { mapMemberEligibilityError } from '../credits/member-eligibility-error.js';

/** A digest the sandbox issued. Finalize routes on it, since a finalize carries no key. */
export const isSandboxDigest = (digest: string) => digest.startsWith('sandbox_');

/**
 * Earn and redeem for a SANDBOX key (OCT-297): the same request checks, program rules and response
 * shapes as live (`EarnService`, `PosRedemptionService`), against the sandbox ledger instead of
 * the real one. What is deliberately different:
 *
 * - Chain dispatch is replaced by nothing: an earn is CONFIRMED at once with a synthetic
 *   `sandbox_…` digest, and a redemption's "transaction bytes" are a placeholder any signature
 *   finalizes. No durable command, no worker, no `SuiClientService`, no Enoki.
 * - Points land in `sandbox_credit_balances`, never in `credit_ownerships`.
 * - No `organization_events` are recorded, so no webhook fires and the console stream stays quiet.
 * - The issuance budget is not checked or spent: nothing is issued.
 *
 * Every response carries `isSandbox: true`.
 */
@Injectable()
export class SandboxCreditsService {
  constructor(
    private readonly sandbox: SandboxRepository,
    private readonly creditsRepo: CreditsRepository,
    private readonly programsRepo: ProgramsRepository,
    private readonly campaigns: CampaignsRepository,
  ) {}

  async earn(tenant: TenantContext, request: EarnPointsRequest): Promise<EarnPointsResponse> {
    await this.assertMember(tenant.organizationId, request.organizationEndUserId);
    const program = await requireProgramConfig(this.programsRepo, tenant.organizationId);
    const boost = await campaignBoost(this.campaigns, tenant.organizationId, request.campaignId);
    const points = pointsForPurchase(request.purchaseAmount, program.earnBps, boost.multiplierBps);
    const { transaction, balance } = await this.sandbox
      .earn({
        organizationId: tenant.organizationId,
        organizationEndUserId: request.organizationEndUserId,
        credentialId: tenant.credentialId,
        purchaseAmount: request.purchaseAmount,
        points,
        idempotencyKey: request.idempotencyKey,
        receiptReference: request.receiptReference,
        metadata: request.metadata,
        campaignId: boost.campaignId ?? undefined,
      })
      .catch(mapWriteError);
    return {
      transactionId: transaction.id,
      organizationEndUserId: transaction.organizationEndUserId,
      purchaseAmount: transaction.purchaseAmount,
      estimatedPoints: null,
      pointsEarned: transaction.pointsAmount,
      newBalance: balance.confirmedBalance,
      status: transaction.status,
      idempotencyKey: transaction.idempotencyKey,
      isSandbox: true,
    };
  }

  async reserve(tenant: TenantContext, request: ReservePosRedemptionRequest): Promise<ReservePosRedemptionResponse> {
    assertValidReserveRequest(request);
    await this.assertMember(tenant.organizationId, request.organizationEndUserId);
    await requireProgramConfig(this.programsRepo, tenant.organizationId);
    const hold = await this.sandbox
      .reserve({
        organizationId: tenant.organizationId,
        organizationEndUserId: request.organizationEndUserId,
        credentialId: tenant.credentialId,
        points: request.pointsAmount,
        idempotencyKey: request.idempotencyKey,
        orderReference: request.orderReference,
        benefit: {
          orderReference: request.orderReference,
          discountAmount: request.discountAmount,
          currency: request.currency,
        },
      })
      .catch(mapWriteError);
    const pending = hold.status === 'PENDING';
    return {
      transactionId: hold.id,
      digest: pending ? hold.digest : null,
      transactionBytes: pending ? placeholderBytes(hold.digest) : null,
      status: hold.status,
      idempotencyKey: hold.idempotencyKey,
      isSandbox: true,
    };
  }

  /** Any non-empty signature finalizes a sandbox hold: there is nothing on-chain to verify it against. */
  async finalize(request: FinalizePosRedemptionRequest): Promise<FinalizePosRedemptionResponse> {
    let settled: Awaited<ReturnType<SandboxRepository['finalize']>>;
    try {
      settled = await this.sandbox.finalize(request.digest);
    } catch (error) {
      if (error instanceof SandboxHoldReleasedError) throw new ConflictException(error.message);
      throw error;
    }
    if (!settled) throw new NotFoundException('Reserved redemption not found or expired; reserve again');
    const { transaction, balance } = settled;
    return {
      transactionId: transaction.id,
      organizationEndUserId: transaction.organizationEndUserId,
      pointsRedeemed: transaction.pointsAmount,
      newBalance: balance.confirmedBalance,
      status: transaction.status,
      blockchainDigest: transaction.digest,
      isSandbox: true,
    };
  }

  async balance(organizationId: string, organizationEndUserId: string): Promise<CreditBalanceSnapshot> {
    await this.assertMember(organizationId, organizationEndUserId);
    return toBalance(organizationEndUserId, await this.sandbox.balance(organizationId, organizationEndUserId));
  }

  async listTransactions(
    organizationId: string,
    organizationEndUserId: string,
    query: { limit?: unknown; cursor?: unknown } = {},
  ): Promise<LoyaltyTransactionPage> {
    const limit = query.limit === undefined || query.limit === '' ? 25 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('limit must be 1–100');
    const cursor = query.cursor === undefined || query.cursor === '' ? undefined : query.cursor;
    if (cursor !== undefined && (typeof cursor !== 'string' || !UUID_PATTERN.test(cursor)))
      throw new BadRequestException('Invalid cursor');
    await this.assertMember(organizationId, organizationEndUserId);
    const page = await this.sandbox.listByMember(organizationId, organizationEndUserId, limit, cursor);
    if (!page) throw new BadRequestException('Invalid cursor');
    return { items: page.rows.map(toTransactionDto), nextCursor: page.nextCursor };
  }

  private async assertMember(organizationId: string, organizationEndUserId: string): Promise<void> {
    if ((await this.creditsRepo.findMemberOrganizationId(organizationEndUserId)) !== organizationId) {
      throw new NotFoundException(`Member ${organizationEndUserId} was not found for this organization`);
    }
  }
}

function mapWriteError(error: unknown): never {
  if (error instanceof OperationPayloadConflictError) throw new ConflictException(error.message);
  if (error instanceof SandboxInsufficientPointsError) throw new BadRequestException(error.message);
  throw mapMemberEligibilityError(error);
}

/** Base64 of a JSON marker: signable bytes for a client, plainly not a Sui transaction. */
function placeholderBytes(digest: string): string {
  return Buffer.from(JSON.stringify({ sandbox: true, digest })).toString('base64');
}

function toBalance(organizationEndUserId: string, balance: SandboxBalance): CreditBalanceSnapshot {
  return {
    organizationEndUserId,
    confirmedBalance: balance.confirmedBalance,
    pendingEarn: 0,
    pendingRedemption: balance.pendingRedemption,
    lifetimeEarned: balance.lifetimeEarned,
    lifetimeRedeemed: balance.lifetimeRedeemed,
    asOfCheckpoint: null,
    observedAt: new Date().toISOString(),
    stale: balance.pendingRedemption > 0,
    // The sandbox ledger never opens a CreditAccount on Sui.
    creditAccountId: null,
    isSandbox: true,
  };
}

function toTransactionDto(tx: SandboxTransaction): LoyaltyTransactionDto {
  return {
    id: tx.id,
    organizationId: tx.organizationId,
    organizationEndUserId: tx.organizationEndUserId,
    createdByMembershipId: null,
    blockchainTransactionId: null,
    blockchainDigest: tx.status === 'CONFIRMED' ? tx.digest : null,
    transactionType: tx.transactionType,
    pointsAmount: tx.pointsAmount,
    purchaseAmount: tx.purchaseAmount,
    estimatedPoints: null,
    idempotencyKey: tx.idempotencyKey,
    receiptReference: tx.receiptReference,
    status: tx.status,
    metadata: tx.metadata as Record<string, unknown> | null,
    createdAt: tx.createdAt.toISOString(),
    updatedAt: tx.updatedAt.toISOString(),
    isSandbox: true,
  };
}
