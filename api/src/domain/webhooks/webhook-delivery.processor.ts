import { Injectable, Logger } from '@nestjs/common';
import { WebhooksRepository } from '../../infra/db/repositories/webhooks.repository.js';
import type { webhookDeliveries } from '../../infra/db/schema/webhooks.schema.js';
import { signWebhookPayload } from './webhook-signing.util.js';

export const MAX_DELIVERY_ATTEMPTS = 6;
/** Minutes of backoff per attempt number (1-indexed); last value repeats past the array end. */
const BACKOFF_MINUTES = [1, 2, 5, 15, 30, 60];
const REQUEST_TIMEOUT_MS = 10_000;

function backoffFor(attemptCount: number): Date {
  const minutes = BACKOFF_MINUTES[Math.min(attemptCount - 1, BACKOFF_MINUTES.length - 1)];
  return new Date(Date.now() + minutes * 60_000);
}

/** Carries one claimed delivery through signing, the HTTP attempt, and the retry/dead-letter decision. */
@Injectable()
export class WebhookDeliveryProcessor {
  private readonly logger = new Logger(WebhookDeliveryProcessor.name);

  constructor(private readonly repo: WebhooksRepository) {}

  async process(delivery: typeof webhookDeliveries.$inferSelect): Promise<void> {
    const endpoint = await this.repo.findEndpointById(delivery.endpointId);
    if (!endpoint || endpoint.status !== 'ACTIVE') {
      await this.repo.markDeadLetter(delivery.id, null, 'Endpoint is disabled or no longer exists');
      return;
    }

    const body = JSON.stringify({ id: delivery.id, type: delivery.eventType, data: delivery.payload });
    const signature = signWebhookPayload(body, endpoint.secret);

    try {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-octap-event-id': delivery.id,
          'x-octap-event-type': delivery.eventType,
          'x-octap-signature': signature,
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (response.ok) {
        await this.repo.markDelivered(delivery.id, response.status);
        return;
      }
      await this.handleFailure(delivery, response.status, `HTTP ${response.status}`);
    } catch (err: unknown) {
      await this.handleFailure(delivery, null, err instanceof Error ? err.message : String(err));
    }
  }

  private async handleFailure(
    delivery: typeof webhookDeliveries.$inferSelect,
    responseStatus: number | null,
    error: string,
  ): Promise<void> {
    if (delivery.attemptCount >= MAX_DELIVERY_ATTEMPTS) {
      this.logger.error(`delivery ${delivery.id} exhausted retries, dead-lettering: ${error}`);
      await this.repo.markDeadLetter(delivery.id, responseStatus, error);
      return;
    }
    this.logger.warn(`delivery ${delivery.id} attempt ${delivery.attemptCount} failed: ${error}`);
    await this.repo.scheduleRetry(delivery.id, backoffFor(delivery.attemptCount), responseStatus, error);
  }
}
