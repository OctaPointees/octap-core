import { Module } from '@nestjs/common';
import { PostgresModule } from '../../infra/db/postgres.module.js';
import { EnokiModule } from '../../infra/clients/enoki/enoki.module.js';
import { SuiTransactionBuilderModule } from '../../infra/clients/sui/sui-transaction-builder.module.js';
import { IdentityService } from './identity.service.js';
import { SponsoredTransactionService } from './sponsored-transaction.service.js';

@Module({
  imports: [PostgresModule, EnokiModule, SuiTransactionBuilderModule],
  providers: [IdentityService, SponsoredTransactionService],
  exports: [IdentityService, SponsoredTransactionService],
})
export class IdentityModule {}
