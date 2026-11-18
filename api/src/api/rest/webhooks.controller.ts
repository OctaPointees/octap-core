import { Controller, Get } from '@nestjs/common';
import { WebhookEndpointsService } from '#domain/webhooks/webhook-endpoints.service.js';
import { WebhookDeliveryService } from '#domain/webhooks/webhook-delivery.service.js';
import { Scopes } from '#infra/auth/scopes.decorator.js';
import { Tenant } from '#infra/auth/tenant.decorator.js';
import type { TenantContext } from '#infra/auth/tenant-context.js';

/**
 * Read-only with an API key. Registering, enabling, disabling, rotating a secret and replaying a
 * delivery are the Owner's, from the console (`ConsoleWebhooksController`).
 */
@Controller('v1/webhooks')
export class WebhooksController {
  constructor(
    private readonly endpoints: WebhookEndpointsService,
    private readonly deliveries: WebhookDeliveryService,
  ) {}

  @Get('endpoints')
  @Scopes('read')
  async listEndpoints(@Tenant() tenant: TenantContext) {
    return this.endpoints.list(tenant.organizationId);
  }

  @Get('deliveries')
  @Scopes('read')
  async listDeliveries(@Tenant() tenant: TenantContext) {
    return this.deliveries.list(tenant.organizationId);
  }
}
