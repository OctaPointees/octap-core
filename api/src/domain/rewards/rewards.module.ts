import { Module } from '@nestjs/common';
import { PostgresModule } from '#infra/db/postgres.module.js';
import { CreditsModule } from '../credits/credits.module.js';
import { RewardsService } from './rewards.service.js';
import { RefundPolicyService } from './refund-policy.service.js';

@Module({
  imports: [PostgresModule, CreditsModule],
  providers: [RewardsService, RefundPolicyService],
  exports: [RewardsService, RefundPolicyService],
})
export class RewardsModule {}
