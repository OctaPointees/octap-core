import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OperationsRepository } from '#infra/db/repositories/operations.repository.js';
import { OrganizationsRepository } from '#infra/db/repositories/organizations.repository.js';
import { ProgramsService } from '../programs/programs.service.js';

type Operation = Awaited<ReturnType<OperationsRepository['claimNextPending']>>[number];

/** What `GovernanceRepository#decide` queues for an approved `UPDATE_EARN_RATE` request. */
export interface EarnRateChangePayload {
  earnBps: number;
  /** The program's policy version when the request was approved. */
  fromPolicyVersion: number;
  changeRequestId: string;
}

/**
 * Worker-only: rotates the organization's active policy to the earn rate a System Admin approved
 * (OCT-341). A refusal before any chain call (no active program, stale request) is FAILED; anything
 * after it may have reached the chain, so it is UNKNOWN and never retried.
 */
@Injectable()
export class EarnRateChangeProcessor {
  private readonly logger = new Logger(EarnRateChangeProcessor.name);
  constructor(
    private readonly organizations: OrganizationsRepository,
    private readonly operations: OperationsRepository,
    private readonly programs: ProgramsService,
  ) {}
  async process(operation: Operation) {
    const { earnBps, fromPolicyVersion } = operation.payload as EarnRateChangePayload;
    try {
      await this.programs.rotateEarnRate({ organizationId: operation.tenantId, earnBps, fromPolicyVersion });
      await this.organizations.finish(operation.id, 'SUBMITTED');
    } catch (error) {
      this.logger.error(
        `Earn-rate change ${operation.id} failed`,
        error instanceof Error ? error.stack : String(error),
      );
      if (error instanceof NotFoundException) {
        await this.organizations.finish(operation.id, 'FAILED', 'The organization no longer has an active program.');
      } else if (error instanceof ConflictException) {
        await this.organizations.finish(operation.id, 'FAILED', error.message);
      } else {
        await this.operations.markUnknown(
          operation.id,
          'The earn-rate change may have reached the chain. Operator reconciliation is required before approving another.',
        );
      }
    }
  }
}
