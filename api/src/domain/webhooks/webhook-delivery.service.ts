import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import type { DrizzleDb } from '#infra/db/postgres.provider.js';
import { WebhooksRepository } from '#infra/db/repositories/webhooks.repository.js';

@Injectable()
export class WebhookDeliveryService {
  constructor(private readonly repo: WebhooksRepository) {}

  async list(organizationId: string, tx?: DrizzleDb) {
    return this.repo.listDeliveries(organizationId, undefined, tx);
  }

  /** Re-queues a DEAD_LETTER delivery for immediate redelivery, same event id. */
  async replay(organizationId: string, deliveryId: string, tx?: DrizzleDb) {
    const delivery = await this.repo.findDeliveryForOrganization(organizationId, deliveryId, tx);
    if (!delivery) {
      throw new NotFoundException(`Delivery ${deliveryId} was not found for this organization`);
    }
    if (delivery.status !== 'DEAD_LETTER') {
      throw new BadRequestException(`Only a DEAD_LETTER delivery can be replayed (current status: ${delivery.status})`);
    }
    return this.repo.resetForReplay(organizationId, deliveryId, tx);
  }
}
