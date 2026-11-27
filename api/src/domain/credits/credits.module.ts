import { Module } from '@nestjs/common';
import { PostgresModule } from '#infra/db/postgres.module.js';
import { CacheModule } from '#infra/cache/cache.module.js';
import { SuiTransactionBuilderModule } from '#infra/clients/sui/sui-transaction-builder.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { CreditsService } from './credits.service.js';
import { EarnService } from './earn.service.js';
import { IssuanceBudgetService } from './issuance-budget.service.js';
import { ReversalService } from './reversal.service.js';
import { PosRedemptionService } from './pos-redemption.service.js';
import { LedgerEvidenceService } from './ledger-evidence.service.js';

@Module({
  imports: [PostgresModule, CacheModule, SuiTransactionBuilderModule, IdentityModule],
  providers: [
    CreditsService,
    EarnService,
    IssuanceBudgetService,
    ReversalService,
    PosRedemptionService,
    LedgerEvidenceService,
  ],
  exports: [
    CreditsService,
    EarnService,
    IssuanceBudgetService,
    ReversalService,
    PosRedemptionService,
    LedgerEvidenceService,
  ],
})
export class CreditsModule {}
