import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { WebhooksRepository } from '../../infra/db/repositories/webhooks.repository.js';

@Injectable()
export class WebhookDeliveryService {
  private readonly logger = new Logger(WebhookDeliveryService.name);

  constructor(private readonly repo: WebhooksRepository) {}

  /**
   * Fans an event out to every ACTIVE endpoint for the organization. Best-effort relative to
   * the triggering transaction (not inserted in the same DB transaction as the business write
   * that caused it) — a crash between that commit and this call would silently drop the event.
   * Closing that gap needs the generalized outbox from OCT-43; swallows its own errors so a
   * webhook-infra failure never fails the business operation that triggered it.
   */
  async emit(organizationId: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
    try {
      const endpoints = await this.repo.listActiveEndpoints(organizationId);
      for (const endpoint of endpoints) {
        await this.repo.enqueueDelivery({ organizationId, endpointId: endpoint.id, eventType, payload });
      }
    } catch (err: unknown) {
      this.logger.error(
        `failed to enqueue "${eventType}" for org ${organizationId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async list(organizationId: string) {
    return this.repo.listDeliveries(organizationId);
  }

  /** Re-queues a DEAD_LETTER delivery for immediate redelivery, same event id. */
  async replay(organizationId: string, deliveryId: string) {
    const delivery = await this.repo.findDeliveryForOrganization(organizationId, deliveryId);
    if (!delivery) {
      throw new NotFoundException(`Delivery ${deliveryId} was not found for this organization`);
    }
    if (delivery.status !== 'DEAD_LETTER') {
      throw new BadRequestException(`Only a DEAD_LETTER delivery can be replayed (current status: ${delivery.status})`);
    }
    return this.repo.resetForReplay(deliveryId);
  }
}
