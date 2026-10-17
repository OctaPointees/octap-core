import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { WebhooksRepository } from '../../infra/db/repositories/webhooks.repository.js';
import { WebhookDeliveryProcessor } from './webhook-delivery.processor.js';

const POLL_INTERVAL_MS = Number(process.env.WEBHOOK_DELIVERY_POLL_INTERVAL_MS ?? 3000);
const BATCH_SIZE = Number(process.env.WEBHOOK_DELIVERY_BATCH_SIZE ?? 10);

/**
 * Owns the poll loop's lifecycle; `WebhookDeliveryProcessor` carries one claimed delivery
 * through signing and the HTTP attempt. Polls `webhook_deliveries` directly (conditional-update
 * claim, see `WebhooksRepository.claimDueDeliveries`) rather than a queue library, same choice
 * as `ChainSubmitWorker` on the chain-submit path and for the same reason: `infra/queue` is for
 * whichever feature needs one first, and a single worker instance doesn't.
 */
@Injectable()
export class WebhookDeliveryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookDeliveryWorker.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private polling = false;

  constructor(
    private readonly repo: WebhooksRepository,
    private readonly processor: WebhookDeliveryProcessor,
  ) {}

  onModuleInit(): void {
    this.logger.log(`starting, polling every ${POLL_INTERVAL_MS}ms`);
    this.timer = setInterval(() => void this.pollOnce(), POLL_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private async pollOnce(): Promise<void> {
    if (this.polling || this.stopped) {
      return;
    }
    this.polling = true;
    try {
      const claimed = await this.repo.claimDueDeliveries(BATCH_SIZE);
      for (const delivery of claimed) {
        await this.processor.process(delivery);
      }
    } catch (err: unknown) {
      this.logger.error(`poll failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.polling = false;
    }
  }
}
