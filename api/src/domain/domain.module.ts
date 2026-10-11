import { Module } from '@nestjs/common';
import { CreditsModule } from './credits/credits.module.js';
import { RewardsModule } from './rewards/rewards.module.js';
const featureModules = [CreditsModule, RewardsModule];
@Module({ imports: featureModules, exports: featureModules })
export class DomainModule {}
