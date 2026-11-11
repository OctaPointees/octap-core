import { Module } from '@nestjs/common';
import { PostgresModule } from '../db/postgres.module.js';
import { ApiCredentialsService } from './api-credentials.service.js';

/**
 * Credential issue/revoke on its own, so a domain module (the console) can use it without importing
 * `AuthModule`, which would also register the global API-key guard wherever it is imported.
 */
@Module({
  imports: [PostgresModule],
  providers: [ApiCredentialsService],
  exports: [ApiCredentialsService],
})
export class ApiCredentialsModule {}
