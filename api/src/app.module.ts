import { Module } from '@nestjs/common';
import { DomainModule } from './domain/domain.module.js';
import { InfrastructureModule } from './infra/infrastructure.module.js';
import { ConfigModule } from './config/config.module.js';
import { ObservabilityModule } from './observability/observability.module.js';
import { RestModule } from './api/rest/rest.module.js';
import { GrpcModule } from './api/grpc/grpc.module.js';
@Module({ imports: [DomainModule, InfrastructureModule, ConfigModule, ObservabilityModule, RestModule, GrpcModule] })
export class AppModule {}
