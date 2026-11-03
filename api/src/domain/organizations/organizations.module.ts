import { Module } from '@nestjs/common';
import { PostgresModule } from '#infra/db/postgres.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OrganizationsService } from './organizations.service.js';
@Module({
  imports: [PostgresModule, IdentityModule],
  providers: [OrganizationsService],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
