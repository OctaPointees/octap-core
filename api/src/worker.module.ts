import { Module } from '@nestjs/common';
import { DomainModule } from './domain/domain.module.js';
import { InfrastructureModule } from './infra/infrastructure.module.js';
import { SuiModule } from './infra/clients/sui/sui.module.js';
import { ChainSubmitWorker } from './domain/credits/chain-submit.worker.js';
import { ChainSubmitProcessor } from './domain/credits/chain-submit.processor.js';
// Register <feature>.worker.ts / <feature>.processor.ts providers here, never in AppModule.
// SuiModule is imported here only, not in infra/infrastructure.module.ts: the internet-facing
// HTTP process (AppModule) has no reason to ever hold SUI_ISSUER_PRIVATE_KEY in memory.
@Module({
  imports: [DomainModule, InfrastructureModule, SuiModule],
  providers: [ChainSubmitWorker, ChainSubmitProcessor],
})
export class WorkerModule {}
