import { Module } from '@nestjs/common';
import { PostgresModule } from '#infra/db/postgres.module.js';
import { SandboxCreditsService } from './sandbox-credits.service.js';

/** Sandbox mode (OCT-297). Imports nothing that reaches the chain, the outbox or Enoki. */
@Module({
  imports: [PostgresModule],
  providers: [SandboxCreditsService],
  exports: [SandboxCreditsService],
})
export class SandboxModule {}
