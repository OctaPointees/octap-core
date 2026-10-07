import { Module } from '@nestjs/common';
import { PostgresModule } from '../../infra/db/postgres.module.js';
import { CreditsService } from './credits.service.js';
import { EarnService } from './earn.service.js';
import { RedemptionService } from './redemption.service.js';
import { ReversalService } from './reversal.service.js';
import { ExpiryService } from './expiry.service.js';

@Module({
  imports: [PostgresModule],
  providers: [CreditsService, EarnService, RedemptionService, ReversalService, ExpiryService],
  exports: [CreditsService, EarnService, RedemptionService, ReversalService, ExpiryService],
})
export class CreditsModule {}
