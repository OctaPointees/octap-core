import { Module } from '@nestjs/common';
import { PostgresModule } from '#infra/db/postgres.module.js';
import { LicenseService } from './license.service.js';

/** Licenses and the plan catalogue (OCT-329). */
@Module({
  imports: [PostgresModule],
  providers: [LicenseService],
  exports: [LicenseService],
})
export class LicensingModule {}
