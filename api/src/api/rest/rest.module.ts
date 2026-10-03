import { Module } from '@nestjs/common';
import { DomainModule } from '../../domain/domain.module.js';
import { IdentityController } from './identity.controller.js';
import { OrganizationsController } from './organizations.controller.js';
import { MembersController } from './members.controller.js';
import { ProgramsController } from './programs.controller.js';
import { PoliciesController } from './policies.controller.js';
import { CreditsController } from './credits.controller.js';
import { OperationsController } from './operations.controller.js';
import { CampaignsController } from './campaigns.controller.js';
import { RewardsController } from './rewards.controller.js';
import { DeveloperController } from './developer.controller.js';
import { WebhooksController } from './webhooks.controller.js';
import { BillingController } from './billing.controller.js';
import { AnalyticsController } from './analytics.controller.js';
import { AuditController } from './audit.controller.js';
import { NotificationsController } from './notifications.controller.js';
import { AdministrationController } from './administration.controller.js';
@Module({ imports: [DomainModule], controllers: [IdentityController, OrganizationsController, MembersController, ProgramsController, PoliciesController, CreditsController, OperationsController, CampaignsController, RewardsController, DeveloperController, WebhooksController, BillingController, AnalyticsController, AuditController, NotificationsController, AdministrationController] })
export class RestModule {}
