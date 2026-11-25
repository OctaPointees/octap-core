import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { OrganizationEventsRepository } from '#infra/db/repositories/events.repository.js';

/** How long the outbox keeps an event: how far back a console stream can resume (`Last-Event-ID`). */
export const EVENT_RETENTION_DAYS = 30;
const SWEEP_INTERVAL_MS = Number(process.env.EVENT_RETENTION_SWEEP_INTERVAL_MS ?? 3_600_000);
const BATCH_SIZE = 1000;

/**
 * Trims `organization_events` (OCT-326): every sweep deletes events older than
 * `EVENT_RETENTION_DAYS`, in batches, except those a webhook endpoint is still owed or the Owner may
 * still replay (`OrganizationEventsRepository.deleteExpired`). A delivered event's deliveries go with
 * it, so the console's delivery list shows the last 30 days.
 */
@Injectable()
export class EventRetentionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventRetentionWorker.name);
  private timer?: NodeJS.Timeout;
  private sweeping = false;

  constructor(private readonly events: OrganizationEventsRepository) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweepOnce(), SWEEP_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One sweep; returns how many events it deleted. Public for tests; the interval calls it. */
  async sweepOnce(now = new Date()): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    const before = new Date(now.getTime() - EVENT_RETENTION_DAYS * 86_400_000);
    let total = 0;
    try {
      for (;;) {
        const deleted = await this.events.deleteExpired(before, BATCH_SIZE);
        total += deleted;
        if (deleted < BATCH_SIZE) break;
      }
      if (total > 0) this.logger.log(`deleted ${total} events recorded before ${before.toISOString()}`);
    } catch (error: unknown) {
      this.logger.error(`sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.sweeping = false;
    }
    return total;
  }
}
