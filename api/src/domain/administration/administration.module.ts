import { Module } from '@nestjs/common';
import { PostgresModule } from '#infra/db/postgres.module.js';
import { AdministrationService } from './administration.service.js';
@Module({ imports: [PostgresModule], providers: [AdministrationService], exports: [AdministrationService] })
export class AdministrationModule {}
