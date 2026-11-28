import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { LicensesRepository } from '#infra/db/repositories/licenses.repository.js';

const POLL_INTERVAL_MS = Number(process.env.LICENSE_EXPIRY_POLL_INTERVAL_MS ?? 900_000);

/**
 * Sends `license.expiry_notice` (OCT-329 part 3): 30, 7 and 1 days before a license ends, when it
 * enters its grace period and when that is over (`LicensesRepository.recordExpiryNotices`). Polls,
 * because nothing else happens at the moment a license reaches a step. Runs once at start, to catch
 * up on what passed while no worker ran, then every `LICENSE_EXPIRY_POLL_INTERVAL_MS` (15 minutes).
 * Several workers can run it at once: each step is recorded once.
 */
@Injectable()
export class LicenseExpiryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LicenseExpiryWorker.name);
  private timer?: NodeJS.Timeout;
  private polling = false;

  constructor(private readonly licenses: LicensesRepository) {}

  onModuleInit(): void {
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), POLL_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass; returns how many notices it recorded. Public for tests; the interval calls it. */
  async pollOnce(now = new Date()): Promise<number> {
    if (this.polling) return 0;
    this.polling = true;
    try {
      const sent = await this.licenses.recordExpiryNotices(now);
      if (sent > 0) this.logger.log(`recorded ${sent} license expiry notices`);
      return sent;
    } catch (error) {
      this.logger.error(`poll failed: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    } finally {
      this.polling = false;
    }
  }
}
