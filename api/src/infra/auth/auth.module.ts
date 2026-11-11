import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PostgresModule } from '../db/postgres.module.js';
import { CacheModule } from '../cache/cache.module.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { ApiCredentialsModule } from './api-credentials.module.js';

/**
 * Registers ApiKeyGuard as an APP_GUARD so every route in the app is authenticated
 * by default — new controllers can't accidentally ship without a tenant check, which
 * is exactly the gap this module exists to close. Use `@Scopes(...)` to require more
 * than the default (any valid, active credential).
 */
@Module({
  imports: [PostgresModule, CacheModule, ApiCredentialsModule],
  providers: [{ provide: APP_GUARD, useClass: ApiKeyGuard }],
  // CacheModule: `@UseGuards(PublicRateLimitGuard)` resolves REDIS_CLIENT from the controller's module.
  exports: [ApiCredentialsModule, CacheModule],
})
export class AuthModule {}
