import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { RegisterWebhookEndpointRequest } from '@octap/contracts';
import type { DrizzleDb } from '#infra/db/postgres.provider.js';
import { ConsoleAccessError } from '#infra/db/repositories/console-access.js';
import { ConsoleOrganizationsRepository } from '#infra/db/repositories/console-organizations.repository.js';
import { WebhookEndpointsService } from './webhook-endpoints.service.js';
import { WebhookDeliveryService } from './webhook-delivery.service.js';

/**
 * The organization's webhook endpoints and deliveries from the console session. Owner only, reads
 * included: a delivery holds its event's payload, and a Business Developer is a 403 on every route.
 * Every call runs inside the Owner check's transaction, so a write commits only while the caller is
 * still the active Owner of an active organization. Endpoint and delivery rules are
 * `WebhookEndpointsService`'s and `WebhookDeliveryService`'s.
 */
@Injectable()
export class ConsoleWebhooksService {
  constructor(
    private readonly organizations: ConsoleOrganizationsRepository,
    private readonly endpoints: WebhookEndpointsService,
    private readonly deliveries: WebhookDeliveryService,
  ) {}

  private async owner<T>(userId: string, orgId: string, action: (tx: DrizzleDb) => Promise<T>): Promise<T> {
    try {
      return await this.organizations.withOwnerAccess(userId, orgId, action);
    } catch (error) {
      if (error instanceof ConsoleAccessError) throw new ForbiddenException(DENIED);
      throw error;
    }
  }

  listEndpoints(userId: string, orgId: string) {
    return this.owner(userId, orgId, (tx) => this.endpoints.list(orgId, tx));
  }

  /** The response is the only time the signing secret is shown. */
  registerEndpoint(userId: string, orgId: string, input: RegisterWebhookEndpointRequest) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new BadRequestException('Webhook endpoint body must be an object');
    if (typeof input.url !== 'string') throw new BadRequestException('url is required');
    if (input.description !== undefined && typeof input.description !== 'string')
      throw new BadRequestException('description must be a string');
    return this.owner(userId, orgId, (tx) => this.endpoints.register(orgId, input.url, input.description, tx));
  }

  disableEndpoint(userId: string, orgId: string, endpointId: string) {
    return this.owner(userId, orgId, (tx) => this.endpoints.disable(orgId, endpointId, tx));
  }

  enableEndpoint(userId: string, orgId: string, endpointId: string) {
    return this.owner(userId, orgId, (tx) => this.endpoints.enable(orgId, endpointId, tx));
  }

  /** The response is the only time the new secret is shown; the old one stops verifying at once. */
  rotateSecret(userId: string, orgId: string, endpointId: string) {
    return this.owner(userId, orgId, (tx) => this.endpoints.rotateSecret(orgId, endpointId, tx));
  }

  /** Queues a signed `webhook.test` delivery to this endpoint only (OCT-297). */
  sendTestEvent(userId: string, orgId: string, endpointId: string) {
    return this.owner(userId, orgId, (tx) => this.endpoints.sendTest(orgId, endpointId, tx));
  }

  listDeliveries(userId: string, orgId: string) {
    return this.owner(userId, orgId, (tx) => this.deliveries.list(orgId, tx));
  }

  replayDelivery(userId: string, orgId: string, deliveryId: string) {
    return this.owner(userId, orgId, (tx) => this.deliveries.replay(orgId, deliveryId, tx));
  }
}

const DENIED = 'Only an active Owner of an active organization can view or manage its webhooks';
