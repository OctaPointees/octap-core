import { Module } from '@nestjs/common';
import { DomainModule } from './domain/domain.module.js';
import { InfrastructureModule } from './infra/infrastructure.module.js';
import { ObservabilityModule } from './observability/observability.module.js';
import { ConfigModule } from './config/config.module.js';
import { TransactionProcessor } from './domain/credits/transaction.processor.js';
import { TransactionWorker } from './domain/credits/transaction.worker.js';
import { ProjectionProcessor } from './domain/operations/projection.processor.js';
import { ProjectionWorker } from './domain/operations/projection.worker.js';
import { CheckpointProcessor } from './domain/indexer/checkpoint.processor.js';
import { CheckpointWorker } from './domain/indexer/checkpoint.worker.js';
import { WebhookProcessor } from './domain/webhooks/webhook.processor.js';
import { WebhookWorker } from './domain/webhooks/webhook.worker.js';
import { AnalyticsProcessor } from './domain/analytics/analytics.processor.js';
import { AnalyticsWorker } from './domain/analytics/analytics.worker.js';
import { AuditProcessor } from './domain/audit/audit.processor.js';
import { AuditWorker } from './domain/audit/audit.worker.js';
import { ExpiryProcessor } from './domain/credits/expiry.processor.js';
import { ExpiryWorker } from './domain/credits/expiry.worker.js';
import { BillingProcessor } from './domain/billing/billing.processor.js';
import { BillingWorker } from './domain/billing/billing.worker.js';
import { NotificationsProcessor } from './domain/notifications/notifications.processor.js';
import { NotificationsWorker } from './domain/notifications/notifications.worker.js';
@Module({
  imports: [DomainModule, InfrastructureModule, ObservabilityModule, ConfigModule],
  providers: [TransactionProcessor, TransactionWorker, ProjectionProcessor, ProjectionWorker, CheckpointProcessor, CheckpointWorker, WebhookProcessor, WebhookWorker, AnalyticsProcessor, AnalyticsWorker, AuditProcessor, AuditWorker, ExpiryProcessor, ExpiryWorker, BillingProcessor, BillingWorker, NotificationsProcessor, NotificationsWorker],
})
export class WorkerModule {}
