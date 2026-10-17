import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { WebhooksRepository } from '../../infra/db/repositories/webhooks.repository.js';
import { generateWebhookSecret } from './webhook-signing.util.js';

@Injectable()
export class WebhookEndpointsService {
  constructor(private readonly repo: WebhooksRepository) {}

  async register(organizationId: string, url: string, description?: string) {
    if (!url || !/^https?:\/\//i.test(url)) {
      throw new BadRequestException('A valid http(s) URL is required');
    }
    const secret = generateWebhookSecret();
    const endpoint = await this.repo.createEndpoint({ organizationId, url, secret, description });
    // The secret is only ever returned here, on registration.
    return { ...endpoint, secret };
  }

  async list(organizationId: string) {
    const endpoints = await this.repo.listEndpoints(organizationId);
    return endpoints.map((e) => ({
      id: e.id,
      organizationId: e.organizationId,
      url: e.url,
      description: e.description,
      status: e.status,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    }));
  }

  async disable(organizationId: string, endpointId: string) {
    await this.assertOwned(organizationId, endpointId);
    return this.repo.setEndpointStatus(endpointId, 'DISABLED');
  }

  async enable(organizationId: string, endpointId: string) {
    await this.assertOwned(organizationId, endpointId);
    return this.repo.setEndpointStatus(endpointId, 'ACTIVE');
  }

  async rotateSecret(organizationId: string, endpointId: string) {
    await this.assertOwned(organizationId, endpointId);
    const secret = generateWebhookSecret();
    const endpoint = await this.repo.rotateEndpointSecret(endpointId, secret);
    return { ...endpoint, secret };
  }

  private async assertOwned(organizationId: string, endpointId: string) {
    const existing = await this.repo.findEndpointForOrganization(organizationId, endpointId);
    if (!existing) {
      throw new NotFoundException(`Webhook endpoint ${endpointId} was not found for this organization`);
    }
    return existing;
  }
}
