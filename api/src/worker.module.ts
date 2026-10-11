import { Module } from '@nestjs/common';
import { DomainModule } from './domain/domain.module.js';
import { InfrastructureModule } from './infra/infrastructure.module.js';
// Register <feature>.worker.ts / <feature>.processor.ts providers here, never in AppModule.
@Module({
  imports: [DomainModule, InfrastructureModule],
  providers: [],
})
export class WorkerModule {}
