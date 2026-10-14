import { Module } from '@nestjs/common';
import { DomainModule } from '../../domain/domain.module.js';
import { CreditsController } from './credits.controller.js';
import { RewardsController } from './rewards.controller.js';
import { MembersController } from './members.controller.js';
@Module({ imports: [DomainModule], controllers: [CreditsController, RewardsController, MembersController] })
export class RestModule {}
