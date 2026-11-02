import { Module } from '@nestjs/common';
import { DomainModule } from '#domain/domain.module.js';
import { AuthModule } from '#infra/auth/auth.module.js';
import { CreditsController } from './credits.controller.js';
import { RewardsController } from './rewards.controller.js';
import { ApiCredentialsController } from './api-credentials.controller.js';
import { WebhooksController } from './webhooks.controller.js';
import { IdentityController } from './identity.controller.js';
import { ConsoleIdentityController } from './console-identity.controller.js';
import {
  ConsoleOrganizationsController,
  PlatformOrganizationRequestsController,
} from './console-organizations.controller.js';
import { ConsoleAccessGuard } from './console-access.guard.js';
@Module({
  imports: [DomainModule, AuthModule],
  providers: [ConsoleAccessGuard],
  controllers: [
    CreditsController,
    RewardsController,
    ApiCredentialsController,
    WebhooksController,
    IdentityController,
    ConsoleIdentityController,
    ConsoleOrganizationsController,
    PlatformOrganizationRequestsController,
  ],
})
export class RestModule {}
