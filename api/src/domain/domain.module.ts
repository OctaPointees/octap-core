import { Module } from '@nestjs/common';
import { CreditsModule } from './credits/credits.module.js';
import { RewardsModule } from './rewards/rewards.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { IdentityModule } from './identity/identity.module.js';
import { MembersModule } from './members/members.module.js';
import { AdministrationModule } from './administration/administration.module.js';
import { OrganizationsModule } from './organizations/organizations.module.js';
import { McpAuthModule } from './mcp-auth/mcp-auth.module.js';
import { AssistantModule } from './assistant/assistant.module.js';
const featureModules = [
  OrganizationsModule,
  AdministrationModule,
  MembersModule,
  CreditsModule,
  RewardsModule,
  WebhooksModule,
  IdentityModule,
  McpAuthModule,
  AssistantModule,
];
@Module({ imports: featureModules, exports: featureModules })
export class DomainModule {}
