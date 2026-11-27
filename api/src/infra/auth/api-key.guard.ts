import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../cache/redis.provider.js';
import { ApiCredentialsRepository } from '../db/repositories/api-credentials.repository.js';
import { hashApiKey } from './api-key-hash.util.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import { checkRateLimit, rateLimitExceeded } from './rate-limit.util.js';
import { SCOPES_KEY } from './scopes.decorator.js';
import { SANDBOX_NOT_SUPPORTED, SANDBOX_SUPPORTED_KEY } from './sandbox.decorator.js';
import type { TenantContext } from './tenant-context.js';
import { LicensesRepository } from '../db/repositories/licenses.repository.js';
import { outsideRequestContext, setRequestActor } from '#observability/request-context.js';

/**
 * Authenticates server-to-server requests via `Authorization: Bearer <api key>`, resolving
 * the tenant strictly from the matched credential — never from a client-supplied header.
 * Also enforces any `@Scopes(...)` and a per-credential rate limit. Routes marked `@Public()`
 * (customer-device endpoints) skip all of it.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    private readonly credentials: ApiCredentialsRepository,
    private readonly reflector: Reflector,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly licenses: LicensesRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic =
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]) ?? false;
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers['authorization'];
    const rawKey = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : undefined;
    if (!rawKey) {
      throw new UnauthorizedException('Missing API credential: send "Authorization: Bearer <api key>"');
    }

    const keyHash = hashApiKey(rawKey);
    const credential = await this.credentials.findByKeyHash(keyHash);
    if (!credential || credential.status !== 'ACTIVE') {
      throw new UnauthorizedException('API credential is invalid or has been revoked');
    }
    if (credential.expiresAt && credential.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('API credential has expired');
    }

    if (credential.organizationStatus !== 'ACTIVE') throw new ForbiddenException('Organization is not active');

    const claimedOrgId = request.headers['x-organization-id'];
    if (claimedOrgId && claimedOrgId !== credential.organizationId) {
      throw new ForbiddenException('The x-organization-id header does not match this API credential');
    }

    const tenant: TenantContext = {
      organizationId: credential.organizationId,
      credentialId: credential.id,
      scopes: credential.scopes as string[],
      environment: credential.environment,
    };
    request.tenant = tenant;
    setRequestActor({ type: 'CREDENTIAL', id: credential.id });

    const requiredScopes =
      this.reflector.getAllAndOverride<string[]>(SCOPES_KEY, [context.getHandler(), context.getClass()]) ?? [];
    const missingScope = requiredScopes.find((scope) => !tenant.scopes.includes(scope));
    if (missingScope) {
      throw new ForbiddenException(`This API credential is missing the required "${missingScope}" scope`);
    }

    // A sandbox key works only while the organization's license includes the sandbox (OCT-329).
    if (tenant.environment === 'SANDBOX') await this.licenses.requireFeature(tenant.organizationId, 'sandbox');

    // The sandbox boundary (OCT-297): a sandbox key may read, and may write only where the route
    // handles sandbox itself. Everything else is refused here, before any handler runs.
    if (tenant.environment === 'SANDBOX' && request.method !== 'GET' && request.method !== 'HEAD') {
      const supported =
        this.reflector.getAllAndOverride<boolean>(SANDBOX_SUPPORTED_KEY, [context.getHandler(), context.getClass()]) ??
        false;
      if (!supported) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: SANDBOX_NOT_SUPPORTED,
          message: 'This route is not available to sandbox keys; use a live key',
        });
      }
    }

    const rateLimitResult = await checkRateLimit(this.redis, credential.id);
    if (rateLimitResult === 'exceeded') {
      throw rateLimitExceeded(context, 'Rate limit exceeded for this API credential');
    }
    if (rateLimitResult === 'unavailable') {
      throw new ServiceUnavailableException('Rate limiting is temporarily unavailable; refusing to fail open');
    }

    // Not awaited, so the request doesn't wait on it; caught, so a failed write is logged instead
    // of becoming an unhandled rejection, which would stop the process.
    // Outside the request context: bookkeeping, not an action of the caller.
    void outsideRequestContext(() => this.credentials.touchLastUsed(credential.organizationId, credential.id)).catch(
      (error: unknown) => {
        this.logger.error(
          `Could not record lastUsedAt for API credential ${credential.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );

    return true;
  }
}
