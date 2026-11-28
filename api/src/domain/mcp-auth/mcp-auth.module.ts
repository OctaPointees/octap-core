import { Module } from '@nestjs/common';
import { PostgresModule } from '#infra/db/postgres.module.js';
import { CacheModule } from '#infra/cache/cache.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { McpConfirmationService } from './mcp-confirmation.service.js';
import { McpOAuthService } from './mcp-oauth.service.js';

@Module({
  imports: [PostgresModule, CacheModule, IdentityModule],
  providers: [McpOAuthService, McpConfirmationService],
  exports: [McpOAuthService, McpConfirmationService],
})
export class McpAuthModule {}
