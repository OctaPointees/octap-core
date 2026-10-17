import { Module } from '@nestjs/common';
import { DomainModule } from './domain/domain.module.js';
import { InfrastructureModule } from './infra/infrastructure.module.js';
import { WebhookDeliveryWorker } from './domain/webhooks/webhook-delivery.worker.js';
import { WebhookDeliveryProcessor } from './domain/webhooks/webhook-delivery.processor.js';
// Register <feature>.worker.ts / <feature>.processor.ts providers here, never in AppModule.
@Module({
  imports: [DomainModule, InfrastructureModule],
  providers: [WebhookDeliveryWorker, WebhookDeliveryProcessor],
})
export class WorkerModule {}
