import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { REQUEST_LOG_RETENTION_DAYS } from '@octap/contracts';
import { RequestLogsRepository } from '#infra/db/repositories/request-logs.repository.js';

const SWEEP_INTERVAL_MS = Number(process.env.REQUEST_LOG_RETENTION_SWEEP_INTERVAL_MS ?? 3_600_000);
const BATCH_SIZE = 5000;

/**
 * Trims `api_request_logs` (OCT-298): every sweep deletes rows older than
 * `REQUEST_LOG_RETENTION_DAYS`, in batches, so one sweep never holds a long lock.
 */
@Injectable()
export class RequestLogRetentionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RequestLogRetentionWorker.name);
  private timer?: NodeJS.Timeout;
  private sweeping = false;

  constructor(private readonly logs: RequestLogsRepository) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweepOnce(), SWEEP_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One sweep; returns how many rows it deleted. Public for tests; the interval calls it. */
  async sweepOnce(now = new Date()): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    const before = new Date(now.getTime() - REQUEST_LOG_RETENTION_DAYS * 86_400_000);
    let total = 0;
    try {
      for (;;) {
        const deleted = await this.logs.deleteExpired(before, BATCH_SIZE);
        total += deleted;
        if (deleted < BATCH_SIZE) break;
      }
      if (total > 0) this.logger.log(`deleted ${total} request log rows recorded before ${before.toISOString()}`);
    } catch (error: unknown) {
      this.logger.error(`sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.sweeping = false;
    }
    return total;
  }
}
