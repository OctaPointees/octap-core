import { Module } from '@nestjs/common';
import { PostgresModule } from '../../infra/db/postgres.module.js';
import { WebhooksModule } from '../webhooks/webhooks.module.js';
import { CreditsService } from './credits.service.js';
import { EarnService } from './earn.service.js';
import { RedemptionService } from './redemption.service.js';
import { ReversalService } from './reversal.service.js';

@Module({
  imports: [PostgresModule, WebhooksModule],
  providers: [CreditsService, EarnService, RedemptionService, ReversalService],
  exports: [CreditsService, EarnService, RedemptionService, ReversalService],
})
export class CreditsModule {}
