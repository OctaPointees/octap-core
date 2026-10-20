import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PostgresModule } from '../db/postgres.module.js';
import { CacheModule } from '../cache/cache.module.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { ApiCredentialsService } from './api-credentials.service.js';

/**
 * Registers ApiKeyGuard as an APP_GUARD so every route in the app is authenticated
 * by default — new controllers can't accidentally ship without a tenant check, which
 * is exactly the gap this module exists to close. Use `@Scopes(...)` to require more
 * than the default (any valid, active credential), and `@RequireSignedRequest()` to
 * additionally require HMAC request signing with replay protection.
 */
@Module({
  imports: [PostgresModule, CacheModule],
  providers: [{ provide: APP_GUARD, useClass: ApiKeyGuard }, ApiCredentialsService],
  exports: [ApiCredentialsService],
})
export class AuthModule {}
