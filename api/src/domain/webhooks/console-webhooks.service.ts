import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { RegisterWebhookEndpointRequest } from '@octap/contracts';
import type { DrizzleDb } from '#infra/db/postgres.provider.js';
import { ConsoleAccessError } from '#infra/db/repositories/console-access.js';
import { ConsoleOrganizationsRepository } from '#infra/db/repositories/console-organizations.repository.js';
import { WebhookEndpointsService } from './webhook-endpoints.service.js';
import { WebhookDeliveryService } from './webhook-delivery.service.js';

/**
 * The organization's webhook endpoints and deliveries from the console session.
 *
 * - Owner or Business Developer: list endpoints and deliveries, send a test event, replay a
 *   dead-lettered delivery. That is what building and debugging an integration takes, and none of it
 *   changes where events go or how they are signed: a replay resends an event already recorded.
 * - Owner only: register, disable, enable and rotate a secret. Registering chooses where the
 *   organization's events are sent and returns the signing secret; the others can break a live
 *   integration at once. This is the same line as for API keys, where only the Owner manages a live
 *   `write` key.
 *
 * Every call runs inside its access check's transaction, holding the organization and membership
 * rows FOR SHARE, so a write commits only while the caller still has that access. Endpoint and
 * delivery rules are `WebhookEndpointsService`'s and `WebhookDeliveryService`'s.
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
      if (error instanceof ConsoleAccessError) throw new ForbiddenException(OWNER_ONLY);
      throw error;
    }
  }

  /** Owner or Business Developer. */
  private async developer<T>(userId: string, orgId: string, action: (tx: DrizzleDb) => Promise<T>): Promise<T> {
    try {
      return await this.organizations.withEditorAccess(userId, orgId, action);
    } catch (error) {
      if (error instanceof ConsoleAccessError) throw new ForbiddenException(DENIED);
      throw error;
    }
  }

  listEndpoints(userId: string, orgId: string) {
    return this.developer(userId, orgId, (tx) => this.endpoints.list(orgId, tx));
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
    return this.developer(userId, orgId, (tx) => this.endpoints.sendTest(orgId, endpointId, tx));
  }

  listDeliveries(userId: string, orgId: string) {
    return this.developer(userId, orgId, (tx) => this.deliveries.list(orgId, tx));
  }

  /** Re-queues a DEAD_LETTER delivery, same event id and payload. */
  replayDelivery(userId: string, orgId: string, deliveryId: string) {
    return this.developer(userId, orgId, (tx) => this.deliveries.replay(orgId, deliveryId, tx));
  }
}

const DENIED = 'Only an active Owner or Business Developer of an active organization can view its webhooks';
const OWNER_ONLY = 'Only an active Owner of an active organization can register or change its webhook endpoints';
