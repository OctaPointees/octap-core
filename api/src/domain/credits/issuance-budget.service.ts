import { ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { operationShardIndex } from '@octap/chain';
import type { BudgetWarningThreshold, IssuanceBudgetDto } from '@octap/contracts';
import { SuiTransactionBuilderClient } from '#infra/clients/sui/sui-transaction-builder.client.js';
import {
  ConsoleAccessError,
  ConsoleOrganizationsRepository,
} from '#infra/db/repositories/console-organizations.repository.js';
import { OperationsRepository } from '#infra/db/repositories/operations.repository.js';
import { ORGANIZATION_BUDGET_TOP_UP_COMMAND } from '#infra/db/repositories/organizations.repository.js';
import { ProgramsRepository } from '#infra/db/repositories/programs.repository.js';
import type { ResolvedProgramConfig } from '../programs/program-config.js';

const RECENT_TOP_UPS = 20;
const WARNING_THRESHOLDS: BudgetWarningThreshold[] = [95, 80];

/** Judged on the fullest shard, because a dry shard refuses earns even while others have budget left. */
function warningThresholdFor(capacity: number, shards: IssuanceBudgetDto['shards']): BudgetWarningThreshold | null {
  const share = capacity / shards.length;
  const lowest = Math.min(...shards.map((shard) => shard.remaining));
  const usedPercent = (1 - lowest / share) * 100;
  return WARNING_THRESHOLDS.find((threshold) => usedPercent >= threshold) ?? null;
}

/** Reads a program's issuance budget from the chain, the only place its live value exists. */
@Injectable()
export class IssuanceBudgetService {
  private readonly logger = new Logger(IssuanceBudgetService.name);

  constructor(
    private readonly programs: ProgramsRepository,
    private readonly operations: OperationsRepository,
    private readonly chain: SuiTransactionBuilderClient,
    private readonly access: ConsoleOrganizationsRepository,
  ) {}

  async read(organizationId: string): Promise<IssuanceBudgetDto> {
    const program = await this.programs.findByOrganization(organizationId);
    if (program?.status !== 'ACTIVE' || !program.budgetShardIds?.length) {
      throw new NotFoundException('This organization has no active program');
    }
    let shards: IssuanceBudgetDto['shards'];
    try {
      shards = await this.readShards(program.budgetShardIds);
    } catch {
      throw new ServiceUnavailableException('The budget could not be read from the chain; try again');
    }
    const capacity = await this.capacityOf(organizationId, Number(program.totalBudget));
    const topUps = await this.operations.listRecent(organizationId, ORGANIZATION_BUDGET_TOP_UP_COMMAND, RECENT_TOP_UPS);
    return {
      organizationId,
      remaining: shards.reduce((total, shard) => total + shard.remaining, 0),
      initialBudget: Number(program.totalBudget),
      capacity,
      warningThreshold: warningThresholdFor(capacity, shards),
      shards,
      recentTopUps: topUps.map((operation) => ({
        operationId: operation.id,
        amount: (operation.payload as { amount: number }).amount,
        status: operation.status,
        createdAt: operation.createdAt.toISOString(),
      })),
      observedAt: new Date().toISOString(),
    };
  }

  private readShards(shardIds: string[]): Promise<IssuanceBudgetDto['shards']> {
    return Promise.all(
      shardIds.map(async (shardId) => ({
        shardId,
        remaining: Number(await this.chain.budgetShardRemaining(shardId)),
      })),
    );
  }

  private async capacityOf(organizationId: string, initialBudget: number): Promise<number> {
    return (
      initialBudget + (await this.operations.sumAppliedAmounts(organizationId, ORGANIZATION_BUDGET_TOP_UP_COMMAND))
    );
  }

  /** Worker-only: reports each program that crossed a threshold. One unreadable program skips only itself. */
  async checkWarnings(): Promise<void> {
    for (const program of await this.programs.listActive()) {
      if (!program.budgetShardIds?.length) continue;
      try {
        const shards = await this.readShards(program.budgetShardIds);
        const capacity = await this.capacityOf(program.organizationId, Number(program.totalBudget));
        const next = warningThresholdFor(capacity, shards) ?? 0;
        if (next === program.budgetWarningThreshold) continue;
        await this.programs.recordBudgetWarning({
          programId: program.id,
          organizationId: program.organizationId,
          previous: program.budgetWarningThreshold,
          next,
          remaining: shards.reduce((total, shard) => total + shard.remaining, 0),
          capacity,
        });
      } catch (error) {
        this.logger.warn(
          `Could not check the budget of program ${program.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  async readAsMember(userId: string, organizationId: string): Promise<IssuanceBudgetDto> {
    try {
      await this.access.withAccess(userId, organizationId, false, async () => undefined);
    } catch (error) {
      if (error instanceof ConsoleAccessError) throw new ForbiddenException('Organization access is required');
      throw error;
    }
    return this.read(organizationId);
  }

  /**
   * Whether the shard that owns this key can cover `points`. Best effort: earns still in flight
   * aren't counted, and an unreadable chain answers true, because the chain enforces the budget
   * anyway and `credits.earn.failed` reports the result.
   */
  async canCover(program: ResolvedProgramConfig, idempotencyKey: string, points: number): Promise<boolean> {
    const key = new TextEncoder().encode(idempotencyKey);
    const shardId = program.budgetShardIds[operationShardIndex(key, program.budgetShardIds.length)];
    try {
      return (await this.chain.budgetShardRemaining(shardId)) >= BigInt(points);
    } catch (error) {
      this.logger.warn(
        `Could not read budget shard ${shardId}; leaving the check to the chain: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return true;
    }
  }
}
