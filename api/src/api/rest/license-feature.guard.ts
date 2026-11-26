import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { LicenseFeature } from '@octap/contracts';
import { REQUIRES_FEATURE_KEY } from '#infra/auth/requires-feature.decorator.js';
import type { TenantContext } from '#infra/auth/tenant-context.js';
import { LicensesRepository } from '#infra/db/repositories/licenses.repository.js';
import type { ConsoleRequest } from './console-access.guard.js';

/**
 * Enforces `@RequiresFeature` (OCT-329). Runs after the caller is authenticated: an API key's
 * organization, or, on a console route, the `:organizationId` the signed-in user belongs to. A
 * console user who isn't a member passes through untouched, so the route's own access check still
 * answers them 403 and they learn nothing about the organization's license.
 */
@Injectable()
export class LicenseFeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly licenses: LicensesRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<LicenseFeature | undefined>(REQUIRES_FEATURE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!feature) return true;
    const request = context.switchToHttp().getRequest<ConsoleRequest & { tenant?: TenantContext }>();
    const organizationId = request.tenant?.organizationId ?? this.memberOrganization(request);
    if (organizationId) await this.licenses.requireFeature(organizationId, feature);
    return true;
  }

  private memberOrganization(request: ConsoleRequest): string | undefined {
    const organizationId = request.params?.organizationId as string | undefined;
    const member = request.consoleIdentity?.organizations.some((org) => org.organizationId === organizationId);
    return member ? organizationId : undefined;
  }
}
