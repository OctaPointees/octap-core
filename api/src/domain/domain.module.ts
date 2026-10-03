import { Module } from '@nestjs/common';
import { IdentityModule } from './identity/identity.module.js';
import { AuthorizationModule } from './authorization/authorization.module.js';
import { OrganizationsModule } from './organizations/organizations.module.js';
import { MembersModule } from './members/members.module.js';
import { ProgramsModule } from './programs/programs.module.js';
import { PoliciesModule } from './policies/policies.module.js';
import { CreditsModule } from './credits/credits.module.js';
import { OperationsModule } from './operations/operations.module.js';
import { CampaignsModule } from './campaigns/campaigns.module.js';
import { RewardsModule } from './rewards/rewards.module.js';
import { DeveloperModule } from './developer/developer.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { BillingModule } from './billing/billing.module.js';
import { AnalyticsModule } from './analytics/analytics.module.js';
import { AuditModule } from './audit/audit.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { AdministrationModule } from './administration/administration.module.js';
import { IndexerModule } from './indexer/indexer.module.js';
const featureModules = [IdentityModule, AuthorizationModule, OrganizationsModule, MembersModule, ProgramsModule, PoliciesModule, CreditsModule, OperationsModule, CampaignsModule, RewardsModule, DeveloperModule, WebhooksModule, BillingModule, AnalyticsModule, AuditModule, NotificationsModule, AdministrationModule, IndexerModule];
@Module({ imports: featureModules, exports: featureModules })
export class DomainModule {}
