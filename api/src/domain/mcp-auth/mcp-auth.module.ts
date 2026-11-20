import { Module } from '@nestjs/common';
import { PostgresModule } from '#infra/db/postgres.module.js';
import { CacheModule } from '#infra/cache/cache.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { McpOAuthService } from './mcp-oauth.service.js';

@Module({
  imports: [PostgresModule, CacheModule, IdentityModule],
  providers: [McpOAuthService],
  exports: [McpOAuthService],
})
export class McpAuthModule {}
