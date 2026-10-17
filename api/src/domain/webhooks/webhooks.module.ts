import { Module } from '@nestjs/common';
import { PostgresModule } from '../../infra/db/postgres.module.js';
import { WebhookEndpointsService } from './webhook-endpoints.service.js';
import { WebhookDeliveryService } from './webhook-delivery.service.js';

@Module({
  imports: [PostgresModule],
  providers: [WebhookEndpointsService, WebhookDeliveryService],
  exports: [WebhookEndpointsService, WebhookDeliveryService],
})
export class WebhooksModule {}
