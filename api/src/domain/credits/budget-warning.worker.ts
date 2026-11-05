import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { IssuanceBudgetService } from './issuance-budget.service.js';

const POLL_INTERVAL_MS = Number(process.env.BUDGET_WARNING_POLL_INTERVAL_MS ?? 300_000);

/** Polls instead of hooking each earn, so every confirmation path, reversal and top-up is covered. */
@Injectable()
export class BudgetWarningWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BudgetWarningWorker.name);
  private timer?: NodeJS.Timeout;
  private polling = false;

  constructor(private readonly budget: IssuanceBudgetService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.pollOnce(), POLL_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.budget.checkWarnings();
    } catch (error) {
      this.logger.error(`poll failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.polling = false;
    }
  }
}
