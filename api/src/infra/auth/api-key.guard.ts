import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../cache/redis.provider.js';
import { ApiCredentialsRepository } from '../db/repositories/api-credentials.repository.js';
import { hashApiKey } from './api-key-hash.util.js';
import { claimNonce } from './nonce-store.util.js';
import { checkRateLimit } from './rate-limit.util.js';
import { buildCanonicalRequest, isTimestampFresh, verifyCanonicalSignature } from './request-signing.util.js';
import { REQUIRE_SIGNED_REQUEST_KEY } from './signed-request.decorator.js';
import { SCOPES_KEY } from './scopes.decorator.js';
import type { TenantContext } from './tenant-context.js';

interface SignableRequest {
  headers: Record<string, string | undefined>;
  method: string;
  originalUrl?: string;
  url: string;
  rawBody?: Buffer;
}

/**
 * Authenticates server-to-server requests via `Authorization: Bearer <api key>`, resolving
 * the tenant strictly from the matched credential — never from a client-supplied header.
 * Also enforces any `@Scopes(...)`, a per-credential rate limit, and — on routes marked
 * `@RequireSignedRequest()` — HMAC request signing with replay protection.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly credentials: ApiCredentialsRepository,
    private readonly reflector: Reflector,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
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

    const claimedOrgId = request.headers['x-organization-id'];
    if (claimedOrgId && claimedOrgId !== credential.organizationId) {
      throw new ForbiddenException('The x-organization-id header does not match this API credential');
    }

    const tenant: TenantContext = {
      organizationId: credential.organizationId,
      credentialId: credential.id,
      scopes: credential.scopes as string[],
    };
    request.tenant = tenant;

    const requiredScopes =
      this.reflector.getAllAndOverride<string[]>(SCOPES_KEY, [context.getHandler(), context.getClass()]) ?? [];
    const missingScope = requiredScopes.find((scope) => !tenant.scopes.includes(scope));
    if (missingScope) {
      throw new ForbiddenException(`This API credential is missing the required "${missingScope}" scope`);
    }

    const rateLimitResult = await checkRateLimit(this.redis, credential.id);
    if (rateLimitResult === 'exceeded') {
      throw new ForbiddenException('Rate limit exceeded for this API credential');
    }
    if (rateLimitResult === 'unavailable') {
      throw new ServiceUnavailableException('Rate limiting is temporarily unavailable; refusing to fail open');
    }

    const requiresSignedRequest =
      this.reflector.getAllAndOverride<boolean>(REQUIRE_SIGNED_REQUEST_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;
    if (requiresSignedRequest) {
      await this.verifySignedRequest(request, credential.id, keyHash);
    }

    void this.credentials.touchLastUsed(credential.id);

    return true;
  }

  private async verifySignedRequest(request: SignableRequest, credentialId: string, signingKey: string): Promise<void> {
    const timestampHeader = request.headers['x-octap-timestamp'];
    const nonce = request.headers['x-octap-nonce'];
    const signature = request.headers['x-octap-signature'];
    if (!timestampHeader || !nonce || !signature) {
      throw new UnauthorizedException(
        'This route requires a signed request: X-OctaP-Timestamp, X-OctaP-Nonce, X-OctaP-Signature',
      );
    }

    const timestamp = Number(timestampHeader);
    if (!Number.isFinite(timestamp) || !isTimestampFresh(timestamp)) {
      throw new UnauthorizedException('X-OctaP-Timestamp is missing, malformed, or outside the replay window');
    }

    // request.rawBody requires NestFactory.create(AppModule, { rawBody: true }) (see main.ts) —
    // verifying against a re-serialized JSON.stringify(request.body) would reject a
    // legitimately-signed request whose body happened to serialize with different key order.
    const rawBody: Buffer | undefined = request.rawBody;
    const canonical = buildCanonicalRequest({
      method: request.method,
      path: request.originalUrl ?? request.url,
      timestamp: timestampHeader,
      nonce,
      rawBody: rawBody ? rawBody.toString('utf8') : '',
    });
    if (!verifyCanonicalSignature(canonical, signature, signingKey)) {
      throw new UnauthorizedException('Invalid request signature');
    }

    // Checked only after the signature verifies: a forged request shouldn't be able to burn
    // through nonces for someone else's valid, not-yet-used timestamp/nonce pair.
    const nonceClaimed = await claimNonce(this.redis, credentialId, nonce);
    if (!nonceClaimed) {
      throw new UnauthorizedException('This nonce was already used, or replay protection is unavailable');
    }
  }
}
