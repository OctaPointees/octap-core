import { Module } from '@nestjs/common';
import { PostgresModule } from '../../infra/db/postgres.module.js';
import { CacheModule } from '../../infra/cache/cache.module.js';
import { SuiTransactionBuilderModule } from '../../infra/clients/sui/sui-transaction-builder.module.js';
import { WebhooksModule } from '../webhooks/webhooks.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { CreditsService } from './credits.service.js';
import { EarnService } from './earn.service.js';
import { RedemptionService } from './redemption.service.js';
import { ReversalService } from './reversal.service.js';
import { PosRedemptionService } from './pos-redemption.service.js';

@Module({
  imports: [PostgresModule, CacheModule, SuiTransactionBuilderModule, WebhooksModule, IdentityModule],
  providers: [CreditsService, EarnService, RedemptionService, ReversalService, PosRedemptionService],
  exports: [CreditsService, EarnService, RedemptionService, ReversalService, PosRedemptionService],
})
export class CreditsModule {}
