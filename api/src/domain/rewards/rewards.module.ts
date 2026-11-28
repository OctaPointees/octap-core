import { Module } from '@nestjs/common';
import { PostgresModule } from '#infra/db/postgres.module.js';
import { CacheModule } from '#infra/cache/cache.module.js';
import { SuiTransactionBuilderModule } from '#infra/clients/sui/sui-transaction-builder.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { CreditsModule } from '../credits/credits.module.js';
import { RewardsService } from './rewards.service.js';
import { RefundPolicyService } from './refund-policy.service.js';
import { VoucherUseService } from './voucher-use.service.js';
import { ConsoleRewardsService, ConsoleVoucherBatchService } from './console-rewards.service.js';
import { ConsoleRefundPolicyService } from './console-refund-policy.service.js';
import { VoucherBatchService } from './voucher-batch.service.js';
import { CampaignsService, ConsoleCampaignsService } from './campaigns.service.js';

@Module({
  imports: [PostgresModule, CreditsModule, CacheModule, SuiTransactionBuilderModule, IdentityModule],
  providers: [
    RewardsService,
    RefundPolicyService,
    VoucherUseService,
    ConsoleRewardsService,
    ConsoleRefundPolicyService,
    VoucherBatchService,
    ConsoleVoucherBatchService,
    ConsoleCampaignsService,
    CampaignsService,
  ],
  exports: [
    RewardsService,
    RefundPolicyService,
    VoucherUseService,
    ConsoleRewardsService,
    ConsoleRefundPolicyService,
    VoucherBatchService,
    ConsoleVoucherBatchService,
    ConsoleCampaignsService,
    CampaignsService,
  ],
})
export class RewardsModule {}
