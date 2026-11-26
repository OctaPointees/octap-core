import { Module } from '@nestjs/common';
import { PostgresModule } from '#infra/db/postgres.module.js';
import { ProgramAnalyticsService } from './program-analytics.service.js';

/** Program analytics' read side: how points and vouchers actually moved, for Owner/BD. */
@Module({
  imports: [PostgresModule],
  providers: [ProgramAnalyticsService],
  exports: [ProgramAnalyticsService],
})
export class AnalyticsModule {}
