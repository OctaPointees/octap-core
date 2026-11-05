import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OperationsRepository } from '#infra/db/repositories/operations.repository.js';
import { OrganizationsRepository } from '#infra/db/repositories/organizations.repository.js';
import { ProgramsService } from '../programs/programs.service.js';

type Operation = Awaited<ReturnType<OperationsRepository['claimNextPending']>>[number];

/** Worker-only: executes a top-up a System Admin approved. An unknown outcome is never retried. */
@Injectable()
export class BudgetTopUpProcessor {
  private readonly logger = new Logger(BudgetTopUpProcessor.name);
  constructor(
    private readonly organizations: OrganizationsRepository,
    private readonly operations: OperationsRepository,
    private readonly programs: ProgramsService,
  ) {}
  async process(operation: Operation) {
    const { amount } = operation.payload as { amount: number };
    try {
      await this.programs.topUpBudget({ organizationId: operation.tenantId, amount });
      await this.organizations.finish(operation.id, 'SUBMITTED');
    } catch (error) {
      this.logger.error(`Budget top-up ${operation.id} failed`, error instanceof Error ? error.stack : String(error));
      if (error instanceof NotFoundException) {
        await this.organizations.finish(operation.id, 'FAILED', 'The organization no longer has an active program.');
      } else {
        await this.operations.markUnknown(
          operation.id,
          'The top-up may have reached the chain. Operator reconciliation is required before approving another.',
        );
      }
    }
  }
}
