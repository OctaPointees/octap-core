import { ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { operationShardIndex } from '@octap/chain';
import type { IssuanceBudgetDto } from '@octap/contracts';
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
      shards = await Promise.all(
        program.budgetShardIds.map(async (shardId) => ({
          shardId,
          remaining: Number(await this.chain.budgetShardRemaining(shardId)),
        })),
      );
    } catch {
      throw new ServiceUnavailableException('The budget could not be read from the chain; try again');
    }
    const topUps = await this.operations.listRecent(organizationId, ORGANIZATION_BUDGET_TOP_UP_COMMAND, RECENT_TOP_UPS);
    return {
      organizationId,
      remaining: shards.reduce((total, shard) => total + shard.remaining, 0),
      initialBudget: Number(program.totalBudget),
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
