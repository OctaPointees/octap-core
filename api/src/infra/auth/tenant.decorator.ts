import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { TenantContext } from './tenant-context.js';

/** Pulls the tenant context `ApiKeyGuard` attached to the request. */
export const Tenant = createParamDecorator((_: unknown, ctx: ExecutionContext): TenantContext => {
  const request = ctx.switchToHttp().getRequest();
  return request.tenant;
});
