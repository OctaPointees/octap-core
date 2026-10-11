import { Module } from '@nestjs/common';
import { PostgresModule } from '../../infra/db/postgres.module.js';
import { CreditsService } from './credits.service.js';
import { EarnService } from './earn.service.js';
import { RedemptionService } from './redemption.service.js';

@Module({
  imports: [PostgresModule],
  providers: [CreditsService, EarnService, RedemptionService],
  exports: [CreditsService, EarnService, RedemptionService],
})
export class CreditsModule {}
