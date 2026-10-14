import { Module } from '@nestjs/common';
import { SuiClientService } from './sui.client.js';

/**
 * Imported by `worker.module.ts` only — see `sui.client.ts`'s module doc for why this must
 * never reach `infra/infrastructure.module.ts` (which `AppModule` also imports).
 */
@Module({
  providers: [SuiClientService],
  exports: [SuiClientService],
})
export class SuiModule {}
