import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type {
  BalanceReconciliation,
  BalanceReconciliationStatus,
  LoyaltyTransactionPage,
  ProgramEvidence,
} from '@octap/contracts';
import { CreditsService } from './credits.service.js';
import { REDIS_CLIENT } from '#infra/cache/redis.provider.js';
import { SuiTransactionBuilderClient } from '#infra/clients/sui/sui-transaction-builder.client.js';
import { ConsoleAccessError } from '#infra/db/repositories/console-access.js';
import { ConsoleOrganizationsRepository } from '#infra/db/repositories/console-organizations.repository.js';
import { CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import { ProgramsRepository } from '#infra/db/repositories/programs.repository.js';

/** A reconciliation is a live chain read: cached this long per member, so polling stays cheap. */
export const RECONCILIATION_CACHE_SECONDS = 30;
/** A published policy is frozen on-chain and never changes: its read is cached for an hour. */
const POLICY_CACHE_SECONDS = 3600;

type PolicyDetails = NonNullable<ProgramEvidence['policy']>;

/**
 * Evidence that what OctaP records is what the chain holds (OCT-334, for OCT-328's evidence views):
 * the program's published policy read from its frozen on-chain object, and a member's recorded
 * balance against their `CreditAccount`'s own `credit_account::spendable`. Read-only: a difference
 * is reported, never corrected. Served to API keys (`read`) and to the console's Owner and Business
 * Developers alike.
 */
@Injectable()
export class LedgerEvidenceService {
  private readonly logger = new Logger(LedgerEvidenceService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly creditsRepo: CreditsRepository,
    private readonly programsRepo: ProgramsRepository,
    private readonly chain: SuiTransactionBuilderClient,
    private readonly access: ConsoleOrganizationsRepository,
    private readonly credits: CreditsService,
  ) {}

  async program(organizationId: string): Promise<ProgramEvidence> {
    const program = await this.programsRepo.findByOrganization(organizationId);
    if (!program || program.status !== 'ACTIVE' || !program.programControlId || !program.policyVersionId) {
      throw new NotFoundException('This organization has no provisioned loyalty program yet');
    }
    const policy = await this.policy(program.policyVersionId);
    const policyStatus =
      policy === undefined
        ? 'UNAVAILABLE'
        : policy && policy.earnBps === program.earnBps && policy.expiryMs === Number(program.expiryMs)
          ? 'MATCH'
          : 'MISMATCH';
    return {
      programId: program.id,
      status: program.status,
      programControlId: program.programControlId,
      earnBps: program.earnBps,
      expiryMs: Number(program.expiryMs),
      provisionedAt: program.createdAt.toISOString(),
      policyStatus,
      policy: policy ?? null,
    };
  }

  /**
   * Compares the member's `confirmedBalance` with what the chain says is spendable now. The
   * recorded side is brought up to date first, exactly as a balance read does (due buckets
   * expired, abandoned holds released), so a stale projection is not reported as a difference.
   * Anything still on its way to the chain makes it PENDING rather than a false MISMATCH. A member
   * with no `CreditAccount` yet holds nothing on-chain, which is compared as 0.
   */
  async reconcile(organizationId: string, organizationEndUserId: string): Promise<BalanceReconciliation> {
    if ((await this.creditsRepo.findMemberOrganizationId(organizationEndUserId)) !== organizationId) {
      throw new NotFoundException(`Member ${organizationEndUserId} was not found for this organization`);
    }
    const key = `reconciliation:${organizationId}:${organizationEndUserId}`;
    const cached = await this.redis.get(key);
    if (cached) return JSON.parse(cached) as BalanceReconciliation;

    await this.creditsRepo.expireDueBucketsForMember({ organizationId, organizationEndUserId });
    await this.creditsRepo.releaseAbandonedPosHoldsForMember({ organizationId, organizationEndUserId });
    const ownership = await this.creditsRepo.getOrCreateCreditOwnership(organizationId, organizationEndUserId);
    const recordedBalance = Number(ownership.confirmedBalance);
    const inFlight =
      Number(ownership.pendingEarn) > 0 ||
      Number(ownership.pendingRedemption) > 0 ||
      (await this.creditsRepo.hasUnsettledChainWork(organizationId, organizationEndUserId));

    let ledgerBalance: number | null = null;
    try {
      ledgerBalance = ownership.suiCreditAccountId
        ? Number((await this.chain.creditAccountSpendable(ownership.suiCreditAccountId)) ?? 0n)
        : 0;
    } catch (error: unknown) {
      this.logger.warn(
        `Could not read CreditAccount ${ownership.suiCreditAccountId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const status: BalanceReconciliationStatus =
      ledgerBalance === null
        ? 'UNAVAILABLE'
        : inFlight
          ? 'PENDING'
          : ledgerBalance === recordedBalance
            ? 'MATCH'
            : 'MISMATCH';
    if (status === 'MISMATCH') {
      this.logger.error(
        `Balance mismatch for member ${organizationEndUserId}: recorded ${recordedBalance}, chain ${ledgerBalance}`,
      );
    }
    const result: BalanceReconciliation = {
      organizationEndUserId,
      status,
      creditAccountId: ownership.suiCreditAccountId,
      recordedBalance,
      ledgerBalance,
      difference: ledgerBalance === null ? null : ledgerBalance - recordedBalance,
      checkedAt: new Date().toISOString(),
    };
    // An unreadable chain is not cached: the next call tries again.
    if (status !== 'UNAVAILABLE') await this.redis.set(key, JSON.stringify(result), 'EX', RECONCILIATION_CACHE_SECONDS);
    return result;
  }

  /** The console's routes: Owner or Business Developer of an ACTIVE organization. */
  async programAsMember(userId: string, organizationId: string): Promise<ProgramEvidence> {
    await this.member(userId, organizationId);
    return this.program(organizationId);
  }

  async organizationTransactionsAsMember(
    userId: string,
    organizationId: string,
    query: Record<string, unknown>,
  ): Promise<LoyaltyTransactionPage> {
    await this.member(userId, organizationId);
    return this.credits.listOrganizationTransactions(organizationId, query);
  }

  async reconcileAsMember(userId: string, organizationId: string, memberId: string): Promise<BalanceReconciliation> {
    await this.member(userId, organizationId);
    return this.reconcile(organizationId, memberId);
  }

  private async member(userId: string, organizationId: string): Promise<void> {
    try {
      await this.access.withAccess(userId, organizationId, false, async () => undefined);
    } catch (error) {
      if (error instanceof ConsoleAccessError) throw new ForbiddenException('Organization access is required');
      throw error;
    }
  }

  /** The frozen policy as the chain holds it; null if there is no such object, undefined if unreadable. */
  private async policy(policyVersionId: string): Promise<PolicyDetails | null | undefined> {
    const key = `policy-version:${policyVersionId}`;
    const cached = await this.redis.get(key);
    if (cached) return JSON.parse(cached) as PolicyDetails | null;
    try {
      const details = await this.chain.policyVersionDetails(policyVersionId);
      const policy: PolicyDetails | null = details && {
        policyVersionId,
        version: Number(details.version),
        earnBps: Number(details.earnBps),
        expiryMs: Number(details.expiryMs),
        publishedDigest: details.publishedDigest,
        publishedAt: details.publishedAtMs === null ? null : new Date(details.publishedAtMs).toISOString(),
      };
      await this.redis.set(key, JSON.stringify(policy), 'EX', POLICY_CACHE_SECONDS);
      return policy;
    } catch (error: unknown) {
      this.logger.warn(
        `Could not read PolicyVersion ${policyVersionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }
}
