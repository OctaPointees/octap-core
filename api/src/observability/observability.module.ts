import { Module, RequestMethod, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { PostgresModule } from '#infra/db/postgres.module.js';
import { CacheModule } from '#infra/cache/cache.module.js';
import { SuiTransactionBuilderModule } from '#infra/clients/sui/sui-transaction-builder.module.js';
import { CorrelationIdMiddleware } from './correlation-id.js';
import { HealthService } from './health.service.js';

/**
 * HTTP-process observability: the per-request correlation id (applied to every route, ahead of
 * every guard) and the health/worker-lag report. Nothing here signs or reaches a worker-only module.
 */
@Module({
  imports: [PostgresModule, CacheModule, SuiTransactionBuilderModule],
  providers: [HealthService],
  exports: [HealthService],
})
export class ObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes({ path: '*splat', method: RequestMethod.ALL });
  }
}
