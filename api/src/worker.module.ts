import { Module } from '@nestjs/common';
import { DomainModule } from './domain/domain.module.js';
import { InfrastructureModule } from './infra/infrastructure.module.js';
import { SuiModule } from './infra/clients/sui/sui.module.js';
import { ProgramAdminModule } from './infra/clients/sui/program-admin.module.js';
import { ChainSubmitWorker } from './domain/credits/chain-submit.worker.js';
import { ChainSubmitProcessor } from './domain/credits/chain-submit.processor.js';
import { ChainOutcomeReconciler } from './domain/credits/chain-outcome.reconciler.js';
import { WebhookDeliveryWorker } from './domain/webhooks/webhook-delivery.worker.js';
import { WebhookDeliveryProcessor } from './domain/webhooks/webhook-delivery.processor.js';
import { CheckpointIndexerWorker } from './domain/indexer/checkpoint-indexer.worker.js';
import { CheckpointIndexerProcessor } from './domain/indexer/checkpoint-indexer.processor.js';
import { ProgramsService } from './domain/programs/programs.service.js';
// Register <feature>.worker.ts / <feature>.processor.ts providers here, never in AppModule.
// SuiModule and ProgramAdminModule are imported here only, not in infra/infrastructure.module.ts:
// the internet-facing HTTP process (AppModule) has no reason to ever hold SUI_ISSUER_PRIVATE_KEY
// or SUI_PROGRAM_ADMIN_PRIVATE_KEY in memory. ProgramsService lives here rather than in
// domain/domain.module.ts for the same reason ChainSubmitProcessor does: that module reaches
// AppModule too.
@Module({
  imports: [DomainModule, InfrastructureModule, SuiModule, ProgramAdminModule],
  providers: [
    ChainSubmitWorker,
    ChainSubmitProcessor,
    ChainOutcomeReconciler,
    WebhookDeliveryWorker,
    WebhookDeliveryProcessor,
    CheckpointIndexerWorker,
    CheckpointIndexerProcessor,
    ProgramsService,
  ],
})
export class WorkerModule {}
