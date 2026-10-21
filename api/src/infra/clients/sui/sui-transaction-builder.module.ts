import { Module } from '@nestjs/common';
import { SuiTransactionBuilderClient } from './sui-transaction-builder.client.js';

/**
 * Separate from `sui.module.ts` on purpose: that module is worker-only because
 * `SuiClientService` holds `SUI_ISSUER_PRIVATE_KEY`. `SuiTransactionBuilderClient` holds no
 * signer at all, so this module is safe to import from `infra/infrastructure.module.ts`.
 */
@Module({
  providers: [SuiTransactionBuilderClient],
  exports: [SuiTransactionBuilderClient],
})
export class SuiTransactionBuilderModule {}
