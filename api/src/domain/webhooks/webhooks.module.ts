import { Module } from '@nestjs/common';
import { PostgresModule } from '#infra/db/postgres.module.js';
import { WebhookEndpointsService } from './webhook-endpoints.service.js';
import { WebhookDeliveryService } from './webhook-delivery.service.js';
import { ConsoleWebhooksService } from './console-webhooks.service.js';

@Module({
  imports: [PostgresModule],
  providers: [WebhookEndpointsService, WebhookDeliveryService, ConsoleWebhooksService],
  exports: [WebhookEndpointsService, WebhookDeliveryService, ConsoleWebhooksService],
})
export class WebhooksModule {}
