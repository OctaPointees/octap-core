import { Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { recordTestEvent } from '#infra/db/repositories/events.repository.js';
import { withTenant } from '#infra/db/rls.js';
import type { DrizzleDb } from '#infra/db/postgres.provider.js';
import { WebhooksRepository } from '#infra/db/repositories/webhooks.repository.js';
import { generateWebhookSecret } from './webhook-signing.util.js';

/**
 * Registering and changing an endpoint is the Owner's, from the console (`ConsoleWebhooksService`,
 * which passes its access check's `tx`); an API key with `read` lists them.
 */
@Injectable()
export class WebhookEndpointsService {
  constructor(private readonly repo: WebhooksRepository) {}

  async register(organizationId: string, url: string, description?: string, tx?: DrizzleDb) {
    if (!url || !/^https?:\/\//i.test(url)) {
      throw new BadRequestException('A valid http(s) URL is required');
    }
    const secret = generateWebhookSecret();
    const endpoint = await this.repo.createEndpoint({ organizationId, url, secret, description }, tx);
    // The secret is only ever returned here, on registration, and on rotation.
    return { ...withoutSecret(endpoint), secret };
  }

  async list(organizationId: string, tx?: DrizzleDb) {
    const endpoints = await this.repo.listEndpoints(organizationId, tx);
    return endpoints.map(withoutSecret);
  }

  async disable(organizationId: string, endpointId: string, tx?: DrizzleDb) {
    await this.assertOwned(organizationId, endpointId, tx);
    return withoutSecret(await this.repo.setEndpointStatus(organizationId, endpointId, 'DISABLED', tx));
  }

  async enable(organizationId: string, endpointId: string, tx?: DrizzleDb) {
    await this.assertOwned(organizationId, endpointId, tx);
    return withoutSecret(await this.repo.setEndpointStatus(organizationId, endpointId, 'ACTIVE', tx));
  }

  async rotateSecret(organizationId: string, endpointId: string, tx?: DrizzleDb) {
    await this.assertOwned(organizationId, endpointId, tx);
    const secret = generateWebhookSecret();
    const endpoint = await this.repo.rotateEndpointSecret(organizationId, endpointId, secret, tx);
    return { ...withoutSecret(endpoint), secret };
  }

  /**
   * Queues a `webhook.test` event to this endpoint only, so the Owner can check it receives and
   * verifies deliveries before anything real happens. A DISABLED endpoint gets nothing: 409.
   */
  async sendTest(organizationId: string, endpointId: string, tx: DrizzleDb) {
    const endpoint = await this.assertOwned(organizationId, endpointId, tx);
    if (endpoint.status !== 'ACTIVE') {
      throw new ConflictException('Enable this endpoint before sending it a test event');
    }
    const queued = await withTenant(tx, organizationId, (db) => recordTestEvent(db, { organizationId, endpointId }));
    return { ...queued, endpointId, eventType: 'webhook.test' as const, status: 'PENDING' as const };
  }

  private async assertOwned(organizationId: string, endpointId: string, tx?: DrizzleDb) {
    const existing = await this.repo.findEndpointForOrganization(organizationId, endpointId, tx);
    if (!existing) {
      throw new NotFoundException(`Webhook endpoint ${endpointId} was not found for this organization`);
    }
    return existing;
  }
}

type EndpointRow = Awaited<ReturnType<WebhooksRepository['listEndpoints']>>[number];

/** Every response but register and rotate-secret: the stored secret never leaves otherwise. */
function withoutSecret(e: EndpointRow) {
  return {
    id: e.id,
    organizationId: e.organizationId,
    url: e.url,
    description: e.description,
    status: e.status,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}
