import { Module } from '@nestjs/common';
import { PostgresModule } from '#infra/db/postgres.module.js';
import { CreditsModule } from '../credits/credits.module.js';
import { RewardsService } from './rewards.service.js';

@Module({
  imports: [PostgresModule, CreditsModule],
  providers: [RewardsService],
  exports: [RewardsService],
})
export class RewardsModule {}
