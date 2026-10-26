import { Module } from '@nestjs/common';
import { PostgresModule } from '#infra/db/postgres.module.js';
import { RewardsService } from './rewards.service.js';

@Module({
  imports: [PostgresModule],
  providers: [RewardsService],
  exports: [RewardsService],
})
export class RewardsModule {}
