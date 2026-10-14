import { Module } from '@nestjs/common';
import { CreditsModule } from './credits/credits.module.js';
import { RewardsModule } from './rewards/rewards.module.js';
import { MembersModule } from './members/members.module.js';
const featureModules = [CreditsModule, RewardsModule, MembersModule];
@Module({ imports: featureModules, exports: featureModules })
export class DomainModule {}
