import { Injectable, Logger } from '@nestjs/common';
import { OrganizationsRepository } from '#infra/db/repositories/organizations.repository.js';
import { OperationsRepository } from '#infra/db/repositories/operations.repository.js';
import { ProgramsRepository } from '#infra/db/repositories/programs.repository.js';
import { SuiClientService } from '#infra/clients/sui/sui.client.js';
import { ProgramsService } from '../programs/programs.service.js';
import { provisioningInput } from './provisioning-input.js';
type Operation = Awaited<ReturnType<OperationsRepository['claimNextPending']>>[number];
/** Worker-only: three chain stages can partially succeed. Unknown outcomes must never auto-retry. */
@Injectable()
export class OrganizationProvisioningProcessor {
  private readonly logger = new Logger(OrganizationProvisioningProcessor.name);
  constructor(
    private readonly organizations: OrganizationsRepository,
    private readonly operations: OperationsRepository,
    private readonly programs: ProgramsService,
    private readonly programRepo: ProgramsRepository,
    private readonly sui: SuiClientService,
  ) {}
  async process(operation: Operation) {
    let attempted = false;
    try {
      if (!(await this.organizations.active(operation.tenantId))) throw new Error('Inactive organization');
      if (await this.programRepo.findByOrganization(operation.tenantId)) throw new Error('Program already reserved');
      const payload = operation.payload as Record<string, unknown>;
      const input = provisioningInput({
        earnBps: payload.earnBps,
        expiryDays: payload.expiryDays,
        totalBudget: payload.totalBudget,
        shardCount: payload.shardCount,
        idempotencyKey: operation.idempotencyKey,
      });
      const issuerRecipient = await this.sui.issuerAddress();
      attempted = true;
      await this.programs.provisionForOrganization({
        organizationId: operation.tenantId,
        earnBps: input.earnBps,
        expiryMs: input.expiryDays * 86400000,
        totalBudget: input.totalBudget,
        shardCount: input.shardCount,
        issuerRecipient,
      });
      await this.organizations.finish(operation.id, 'SUBMITTED');
    } catch (error) {
      this.logger.error(
        `Organization provisioning ${operation.id} failed (chain attempted: ${attempted})`,
        error instanceof Error ? error.stack : String(error),
      );
      if (attempted)
        await this.operations.markUnknown(
          operation.id,
          'Provisioning may have partially executed on chain. Operator reconciliation is required before retrying.',
        );
      else
        await this.organizations.finish(
          operation.id,
          'FAILED',
          'Provisioning prerequisites are unavailable or organization/program state changed. No chain provisioning was attempted.',
        );
    }
  }
}
