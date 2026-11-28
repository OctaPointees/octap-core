import { Module } from '@nestjs/common';
import { PostgresModule } from '#infra/db/postgres.module.js';
import { LicenseService } from './license.service.js';
import { LicenseOrderService } from './license-order.service.js';

/** Licenses and the plan catalogue (OCT-329), and the orders that buy them (OCT-330). */
@Module({
  imports: [PostgresModule],
  providers: [LicenseService, LicenseOrderService],
  exports: [LicenseService, LicenseOrderService],
})
export class LicensingModule {}
