import { Module } from '@nestjs/common';
import { IdentityModule } from './application/identity/identity.module.js';
import { AuthorizationModule } from './application/authorization/authorization.module.js';
import { OrganizationsModule } from './application/organizations/organizations.module.js';
import { MembersModule } from './application/members/members.module.js';
import { ProgramsModule } from './application/programs/programs.module.js';
import { PoliciesModule } from './application/policies/policies.module.js';
import { CreditsModule } from './application/credits/credits.module.js';
import { OperationsModule } from './application/operations/operations.module.js';
import { CampaignsModule } from './application/campaigns/campaigns.module.js';
import { RewardsModule } from './application/rewards/rewards.module.js';
import { DeveloperModule } from './application/developer/developer.module.js';
import { WebhooksModule } from './application/webhooks/webhooks.module.js';
import { BillingModule } from './application/billing/billing.module.js';
import { AnalyticsModule } from './application/analytics/analytics.module.js';
import { AuditModule } from './application/audit/audit.module.js';
import { NotificationsModule } from './application/notifications/notifications.module.js';
import { AdministrationModule } from './application/administration/administration.module.js';
import { ObservabilityModule } from './application/observability/observability.module.js';
const featureModules = [IdentityModule, AuthorizationModule, OrganizationsModule, MembersModule, ProgramsModule, PoliciesModule, CreditsModule, OperationsModule, CampaignsModule, RewardsModule, DeveloperModule, WebhooksModule, BillingModule, AnalyticsModule, AuditModule, NotificationsModule, AdministrationModule, ObservabilityModule];
@Module({ imports: featureModules, exports: featureModules })
export class ApplicationModule {}
