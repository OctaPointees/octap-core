import { Module } from '@nestjs/common';
import { DomainModule } from '#domain/domain.module.js';
import { AuthModule } from '#infra/auth/auth.module.js';
import { CreditsController } from './credits.controller.js';
import { RewardsController } from './rewards.controller.js';
import { WebhooksController } from './webhooks.controller.js';
import { CustomerVerificationController, IdentityController } from './identity.controller.js';
import { ConsoleIdentityController } from './console-identity.controller.js';
import {
  ConsoleOrganizationsController,
  PlatformOrganizationRequestsController,
  PlatformOrganizationOwnersController,
} from './console-organizations.controller.js';
import { ConsoleAccessGuard } from './console-access.guard.js';
import { MembersController } from './members.controller.js';
import { ConsoleApiCredentialsController } from './console-api-credentials.controller.js';
import { ConsoleChangeRequestsController, PlatformChangeRequestsController } from './administration.controller.js';
import { PlatformOrganizationsController, OrganizationResolutionController } from './organizations.controller.js';
import { ConsoleIssuanceBudgetController, PlatformIssuanceBudgetController } from './issuance-budget.controller.js';
@Module({
  imports: [DomainModule, AuthModule],
  providers: [ConsoleAccessGuard],
  controllers: [
    PlatformOrganizationsController,
    OrganizationResolutionController,
    ConsoleIssuanceBudgetController,
    PlatformIssuanceBudgetController,
    ConsoleChangeRequestsController,
    PlatformChangeRequestsController,
    MembersController,
    ConsoleApiCredentialsController,
    CreditsController,
    RewardsController,
    WebhooksController,
    IdentityController,
    CustomerVerificationController,
    ConsoleIdentityController,
    ConsoleOrganizationsController,
    PlatformOrganizationRequestsController,
    PlatformOrganizationOwnersController,
  ],
})
export class RestModule {}
