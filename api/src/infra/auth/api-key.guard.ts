import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiCredentialsRepository } from '../db/repositories/api-credentials.repository.js';
import { hashApiKey } from './api-key-hash.util.js';
import { SCOPES_KEY } from './scopes.decorator.js';
import type { TenantContext } from './tenant-context.js';

/**
 * Authenticates server-to-server requests via `Authorization: Bearer <api key>`
 * and resolves the tenant strictly from the matched credential — never from a
 * client-supplied header. Also enforces any `@Scopes(...)` on the route.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly credentials: ApiCredentialsRepository,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers['authorization'];
    const rawKey = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : undefined;
    if (!rawKey) {
      throw new UnauthorizedException('Missing API credential: send "Authorization: Bearer <api key>"');
    }

    const credential = await this.credentials.findByKeyHash(hashApiKey(rawKey));
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

    void this.credentials.touchLastUsed(credential.id);

    return true;
  }
}
