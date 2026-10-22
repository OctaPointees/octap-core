import { Module } from '@nestjs/common';
import { ProgramAdminClient } from './program-admin.client.js';

/**
 * Worker-only, same rule as `sui.module.ts`: never import this from
 * `infra/infrastructure.module.ts`. `ProgramAdminClient` holds `SUI_PROGRAM_ADMIN_PRIVATE_KEY`.
 */
@Module({
  providers: [ProgramAdminClient],
  exports: [ProgramAdminClient],
})
export class ProgramAdminModule {}
