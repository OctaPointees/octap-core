import { Module, RequestMethod, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { PostgresModule } from '#infra/db/postgres.module.js';
import { RequestLogMiddleware } from './request-log.middleware.js';
import { RequestLogsService } from './request-logs.service.js';

/**
 * The developer hub's server side (OCT-46): today the request log (OCT-298). The middleware is
 * applied to every route; it records only calls made with an API key. The retention sweep is a
 * worker (`worker.module.ts`), not provided here.
 */
@Module({
  imports: [PostgresModule],
  providers: [RequestLogsService, RequestLogMiddleware],
  exports: [RequestLogsService],
})
export class DeveloperModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestLogMiddleware).forRoutes({ path: '*splat', method: RequestMethod.ALL });
  }
}
