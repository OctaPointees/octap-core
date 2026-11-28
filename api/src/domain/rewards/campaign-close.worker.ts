import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { CAMPAIGN_CLOSE_BATCH_SIZE, CampaignsRepository } from '#infra/db/repositories/campaigns.repository.js';

const SWEEP_INTERVAL_MS = Number(process.env.CAMPAIGN_CLOSE_SWEEP_INTERVAL_MS ?? 60_000);

/**
 * Ends campaigns once their window is over (OCT-343): ACTIVE or PAUSED with `endsAt` passed becomes
 * ENDED, with a `campaign.ended` audit row from the system (`CampaignsRepository.closeDue`). Runs
 * once at start, to catch up on what ended while no worker ran, then every
 * `CAMPAIGN_CLOSE_SWEEP_INTERVAL_MS`, batch after batch until one comes back short. Several workers
 * can run it at once: rows another one holds are skipped. Reads close their organization's campaigns
 * themselves (`closeDueFor`), and an earn checks `endsAt` on its own, so the interval only bounds
 * when the audit row is written.
 */
@Injectable()
export class CampaignCloseWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CampaignCloseWorker.name);
  private timer?: NodeJS.Timeout;
  private sweeping = false;

  constructor(private readonly campaigns: CampaignsRepository) {}

  onModuleInit(): void {
    void this.sweepOnce();
    this.timer = setInterval(() => void this.sweepOnce(), SWEEP_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One sweep; returns how many campaigns it ended. Public for tests; the interval calls it. */
  async sweepOnce(now = new Date()): Promise<number> {
    let total = 0;
    if (this.sweeping) return total;
    this.sweeping = true;
    try {
      for (;;) {
        const ended = await this.campaigns.closeDue(CAMPAIGN_CLOSE_BATCH_SIZE, now);
        total += ended;
        if (ended < CAMPAIGN_CLOSE_BATCH_SIZE) break;
      }
      if (total > 0) this.logger.log(`ended ${total} campaigns whose window was over`);
    } catch (error: unknown) {
      this.logger.error(`sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.sweeping = false;
    }
    return total;
  }
}
