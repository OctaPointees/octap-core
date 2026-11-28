import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import type { WorkerJobSet } from '#config/env.js';
import { DomainModule } from './domain/domain.module.js';
import { InfrastructureModule } from './infra/infrastructure.module.js';
import { SuiModule } from './infra/clients/sui/sui.module.js';
import { ProgramAdminModule } from './infra/clients/sui/program-admin.module.js';
import { BudgetWarningWorker } from './domain/credits/budget-warning.worker.js';
import { ChainSubmitWorker } from './domain/credits/chain-submit.worker.js';
import { ChainSubmitProcessor } from './domain/credits/chain-submit.processor.js';
import { ChainOutcomeReconciler } from './domain/credits/chain-outcome.reconciler.js';
import { WebhookDeliveryWorker } from './domain/webhooks/webhook-delivery.worker.js';
import { WebhookDeliveryProcessor } from './domain/webhooks/webhook-delivery.processor.js';
import { CheckpointIndexerWorker } from './domain/indexer/checkpoint-indexer.worker.js';
import { CheckpointIndexerProcessor } from './domain/indexer/checkpoint-indexer.processor.js';
import { ProgramsService } from './domain/programs/programs.service.js';
import { OrganizationProvisioningWorker } from './domain/organizations/provisioning.worker.js';
import { OrganizationProvisioningProcessor } from './domain/organizations/provisioning.processor.js';
import { BudgetTopUpProcessor } from './domain/organizations/budget-top-up.processor.js';
import { EarnRateChangeProcessor } from './domain/organizations/earn-rate-change.processor.js';
import { EventRetentionWorker } from './domain/events/event-retention.worker.js';
import { RequestLogRetentionWorker } from './domain/developer/request-log-retention.worker.js';
import { EvidenceSealWorker } from './domain/audit/evidence-seal.worker.js';
import { VoucherExpiryWorker } from './domain/rewards/voucher-expiry.worker.js';
import { EvidenceSealProcessor } from './domain/audit/evidence-seal.processor.js';
import { WalrusConsoleModule } from './infra/clients/walrus/walrus-console.module.js';
// Register <feature>.worker.ts / <feature>.processor.ts providers here, never in AppModule.
// SuiModule and ProgramAdminModule are imported here only, not in infra/infrastructure.module.ts:
// the internet-facing HTTP process (AppModule) has no reason to ever reach the issuer or program
// admin signer (AWS KMS keys, or raw keys off mainnet; infra/clients/sui/signer.ts). ProgramsService lives here rather than in
// domain/domain.module.ts for the same reason ChainSubmitProcessor does: that module reaches
// AppModule too. WalrusConsoleModule (OCT-77) is here for the same reason: only the worker archives.
//
// `WORKER_JOBS=org-setup` (OCT-321) loads only organization setup and the other program-admin
// commands, so a deployment can run them in a worker of their own, the only one given the
// program-admin key. That worker still reaches the issuer signer, for its address only: setup sends
// the new program's IssuerCap there.
const ORG_SETUP: Provider[] = [
  OrganizationProvisioningWorker,
  OrganizationProvisioningProcessor,
  BudgetTopUpProcessor,
  EarnRateChangeProcessor,
  ProgramsService,
];

const EVERYTHING_ELSE: Provider[] = [
  BudgetWarningWorker,
  ChainSubmitWorker,
  ChainSubmitProcessor,
  ChainOutcomeReconciler,
  WebhookDeliveryWorker,
  WebhookDeliveryProcessor,
  EventRetentionWorker,
  CheckpointIndexerWorker,
  CheckpointIndexerProcessor,
  RequestLogRetentionWorker,
  EvidenceSealWorker,
  VoucherExpiryWorker,
  EvidenceSealProcessor,
];

@Module({})
export class WorkerModule {
  static forJobs(jobs: WorkerJobSet = 'all'): DynamicModule {
    return {
      module: WorkerModule,
      imports: [DomainModule, InfrastructureModule, SuiModule, ProgramAdminModule, WalrusConsoleModule],
      providers: jobs === 'org-setup' ? ORG_SETUP : [...ORG_SETUP, ...EVERYTHING_ELSE],
    };
  }
}
