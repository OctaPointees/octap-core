import { Module } from '@nestjs/common';
import { PostgresModule } from '#infra/db/postgres.module.js';
import { CreditsModule } from '../credits/credits.module.js';
import { MembersService } from './members.service.js';
@Module({ imports: [PostgresModule, CreditsModule], providers: [MembersService], exports: [MembersService] })
export class MembersModule {}
