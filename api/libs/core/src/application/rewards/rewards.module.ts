import { Module } from '@nestjs/common';
import { RewardsService } from './rewards.service.js';
@Module({ providers: [RewardsService], exports: [RewardsService] })
export class RewardsModule {}
