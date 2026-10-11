import { Module } from '@nestjs/common';
import { DomainModule } from './domain/domain.module.js';
import { InfrastructureModule } from './infra/infrastructure.module.js';
import { RestModule } from './api/rest/rest.module.js';
@Module({ imports: [DomainModule, InfrastructureModule, RestModule] })
export class AppModule {}
