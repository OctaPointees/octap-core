import { Controller, Post, Get, Body, Param, BadRequestException } from '@nestjs/common';
import { WebhookEndpointsService } from '#domain/webhooks/webhook-endpoints.service.js';
import { WebhookDeliveryService } from '#domain/webhooks/webhook-delivery.service.js';
import { Scopes } from '#infra/auth/scopes.decorator.js';
import { Tenant } from '#infra/auth/tenant.decorator.js';
import type { TenantContext } from '#infra/auth/tenant-context.js';
import type { RegisterWebhookEndpointBodyDto } from '../dto/webhooks.dto.js';

@Controller('v1/webhooks')
export class WebhooksController {
  constructor(
    private readonly endpoints: WebhookEndpointsService,
    private readonly deliveries: WebhookDeliveryService,
  ) {}

  @Post('endpoints')
  @Scopes('admin')
  async registerEndpoint(@Tenant() tenant: TenantContext, @Body() body: RegisterWebhookEndpointBodyDto) {
    if (!body.url) {
      throw new BadRequestException('url is required');
    }
    return this.endpoints.register(tenant.organizationId, body.url, body.description);
  }

  @Get('endpoints')
  @Scopes('read')
  async listEndpoints(@Tenant() tenant: TenantContext) {
    return this.endpoints.list(tenant.organizationId);
  }

  @Post('endpoints/:id/disable')
  @Scopes('admin')
  async disableEndpoint(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.endpoints.disable(tenant.organizationId, id);
  }

  @Post('endpoints/:id/enable')
  @Scopes('admin')
  async enableEndpoint(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.endpoints.enable(tenant.organizationId, id);
  }

  @Post('endpoints/:id/rotate-secret')
  @Scopes('admin')
  async rotateSecret(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.endpoints.rotateSecret(tenant.organizationId, id);
  }

  @Get('deliveries')
  @Scopes('read')
  async listDeliveries(@Tenant() tenant: TenantContext) {
    return this.deliveries.list(tenant.organizationId);
  }

  @Post('deliveries/:id/replay')
  @Scopes('admin')
  async replayDelivery(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.deliveries.replay(tenant.organizationId, id);
  }
}
