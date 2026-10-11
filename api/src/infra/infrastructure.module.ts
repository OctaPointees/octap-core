import { Module } from '@nestjs/common';
import { PostgresModule } from './db/postgres.module.js';
const integrationModules = [PostgresModule];
@Module({ imports: integrationModules, exports: integrationModules })
export class InfrastructureModule {}
