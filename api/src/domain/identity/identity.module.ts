import { Module } from '@nestjs/common';
import { PostgresModule } from '#infra/db/postgres.module.js';
import { ApiCredentialsModule } from '#infra/auth/api-credentials.module.js';
import { EnokiModule } from '#infra/clients/enoki/enoki.module.js';
import { SuiTransactionBuilderModule } from '#infra/clients/sui/sui-transaction-builder.module.js';
import { IdentityService } from './identity.service.js';
import { SponsoredTransactionService } from './sponsored-transaction.service.js';
import { ConsoleIdentityService } from './console-identity.service.js';
import { ConsoleOrganizationsService } from './console-organizations.service.js';
import { GoogleIdentityClient } from '#infra/clients/google/google-identity.client.js';

@Module({
  imports: [PostgresModule, EnokiModule, SuiTransactionBuilderModule, ApiCredentialsModule],
  providers: [
    IdentityService,
    SponsoredTransactionService,
    ConsoleIdentityService,
    GoogleIdentityClient,
    ConsoleOrganizationsService,
  ],
  exports: [
    IdentityService,
    SponsoredTransactionService,
    ConsoleIdentityService,
    GoogleIdentityClient,
    ConsoleOrganizationsService,
  ],
})
export class IdentityModule {}
