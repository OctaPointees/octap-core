import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { OperationsRepository } from '#infra/db/repositories/operations.repository.js';
import {
  ORGANIZATION_BUDGET_TOP_UP_COMMAND,
  ORGANIZATION_PROVISION_COMMAND,
} from '#infra/db/repositories/organizations.repository.js';
import { BudgetTopUpProcessor } from './budget-top-up.processor.js';
import { OrganizationProvisioningProcessor } from './provisioning.processor.js';
const COMMANDS = [ORGANIZATION_PROVISION_COMMAND, ORGANIZATION_BUDGET_TOP_UP_COMMAND];

/** Runs the commands that need the program admin key. */
@Injectable()
export class OrganizationProvisioningWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrganizationProvisioningWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(
    private readonly operations: OperationsRepository,
    private readonly processor: OrganizationProvisioningProcessor,
    private readonly topUps: BudgetTopUpProcessor,
  ) {}
  onModuleInit() {
    if (process.env.ORG_PROVISION_WORKER_ENABLED !== 'true') return;
    const interval = Number(process.env.ORG_PROVISION_POLL_INTERVAL_MS ?? 3000);
    this.timer = setInterval(
      () => {
        void this.pollOnce();
      },
      Number.isFinite(interval) && interval >= 100 ? interval : 3000,
    );
    void this.pollOnce();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async pollOnce() {
    if (this.running) return;
    this.running = true;
    try {
      await this.operations.recoverStaleProcessing(COMMANDS, 30 * 60 * 1000);
      const jobs = await this.operations.claimNextPending(COMMANDS, 1);
      for (const job of jobs) {
        await (job.commandType === ORGANIZATION_BUDGET_TOP_UP_COMMAND ? this.topUps : this.processor).process(job);
      }
    } catch {
      this.logger.error('Organization provisioning poll failed; durable command state will be recovered.');
    } finally {
      this.running = false;
    }
  }
}
