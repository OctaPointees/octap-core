import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
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
