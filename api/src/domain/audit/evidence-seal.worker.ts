import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { EvidenceSealProcessor } from './evidence-seal.processor.js';

const INTERVAL_MS = Number(process.env.EVIDENCE_SEAL_INTERVAL_MS ?? 60_000);

/**
 * Runs `EvidenceSealProcessor` on an interval (OCT-77), when `EVIDENCE_SEAL_ENABLED=true`. Off by
 * default: a deployment turns it on once its issuer address holds the `SealerCap` and has gas.
 */
@Injectable()
export class EvidenceSealWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EvidenceSealWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly processor: EvidenceSealProcessor) {}

  onModuleInit(): void {
    if (process.env.EVIDENCE_SEAL_ENABLED !== 'true') return;
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One run, skipped while the previous one is still going. Public for tests. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { sealed, archived } = await this.processor.runOnce();
      if (sealed || archived) this.logger.log(`sealed ${sealed} and archived ${archived} evidence periods`);
    } catch (error: unknown) {
      this.logger.error(`evidence run failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }
}
