import { Module } from '@nestjs/common';
import { DomainModule } from '../../domain/domain.module.js';
import { AuthModule } from '../../infra/auth/auth.module.js';
import { CreditsController } from './credits.controller.js';
import { RewardsController } from './rewards.controller.js';
import { ApiCredentialsController } from './api-credentials.controller.js';
@Module({
  imports: [DomainModule, AuthModule],
  controllers: [CreditsController, RewardsController, ApiCredentialsController],
})
export class RestModule {}
