import { Module } from '@nestjs/common';
import { DomainModule } from '#domain/domain.module.js';
import { AuthModule } from '#infra/auth/auth.module.js';
import { CreditsController } from './credits.controller.js';
import { RewardsController } from './rewards.controller.js';
import { ApiCredentialsController } from './api-credentials.controller.js';
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
import { ConsoleChangeRequestsController, PlatformChangeRequestsController } from './administration.controller.js';
import { PlatformOrganizationsController, OrganizationResolutionController } from './organizations.controller.js';
@Module({
  imports: [DomainModule, AuthModule],
  providers: [ConsoleAccessGuard],
  controllers: [
    PlatformOrganizationsController,
    OrganizationResolutionController,
    ConsoleChangeRequestsController,
    PlatformChangeRequestsController,
    MembersController,
    CreditsController,
    RewardsController,
    ApiCredentialsController,
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
