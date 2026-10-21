import { Module } from '@nestjs/common';
import { CreditsModule } from './credits/credits.module.js';
import { RewardsModule } from './rewards/rewards.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { IdentityModule } from './identity/identity.module.js';
const featureModules = [CreditsModule, RewardsModule, WebhooksModule, IdentityModule];
@Module({ imports: featureModules, exports: featureModules })
export class DomainModule {}
