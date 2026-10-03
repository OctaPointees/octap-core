import { Module } from '@nestjs/common';
import { ApplicationModule } from '@octap/core';
import { TransactionWorker } from './jobs/transaction.worker.js';
import { ProjectionWorker } from './jobs/projection.worker.js';
import { CheckpointWorker } from './jobs/checkpoint.worker.js';
import { WebhookWorker } from './jobs/webhook.worker.js';
import { AnalyticsWorker } from './jobs/analytics.worker.js';
import { AuditWorker } from './jobs/audit.worker.js';
import { ExpiryWorker } from './jobs/expiry.worker.js';
import { BillingWorker } from './jobs/billing.worker.js';
import { NotificationsWorker } from './jobs/notifications.worker.js';
@Module({
  imports: [ApplicationModule],
  providers: [TransactionWorker, ProjectionWorker, CheckpointWorker, WebhookWorker, AnalyticsWorker, AuditWorker, ExpiryWorker, BillingWorker, NotificationsWorker],
})
export class WorkersModule {}
