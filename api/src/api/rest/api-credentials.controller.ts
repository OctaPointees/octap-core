import { Controller, Post, Get, Delete, Body, Param } from '@nestjs/common';
import { ApiCredentialsService } from '#infra/auth/api-credentials.service.js';
import { Scopes } from '#infra/auth/scopes.decorator.js';
import { RequireSignedRequest } from '#infra/auth/signed-request.decorator.js';
import { Tenant } from '#infra/auth/tenant.decorator.js';
import type { TenantContext } from '#infra/auth/tenant-context.js';

/**
 * Self-service credential management for a tenant that already holds an "admin"-scoped
 * key. The very first credential for a new organization is still provisioned out of band
 * (see `scripts/seed-dev-credential.mjs`) — there is no bootstrap endpoint, by design.
 */
@Controller('v1/api-credentials')
export class ApiCredentialsController {
  constructor(private readonly credentials: ApiCredentialsService) {}

  @Get()
  @Scopes('admin')
  async list(@Tenant() tenant: TenantContext) {
    return this.credentials.list(tenant.organizationId);
  }

  @Post()
  @Scopes('admin')
  @RequireSignedRequest()
  async issue(@Tenant() tenant: TenantContext, @Body() body: { name: string; scopes?: string[] }) {
    const { credential, rawKey } = await this.credentials.issue(tenant.organizationId, body.name, body.scopes);
    // The raw key is only ever present in this one response.
    return { ...credential, rawKey };
  }

  @Delete(':id')
  @Scopes('admin')
  @RequireSignedRequest()
  async revoke(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.credentials.revoke(tenant.organizationId, id);
  }

  @Post(':id/rotate')
  @Scopes('admin')
  @RequireSignedRequest()
  async rotate(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    const { credential, rawKey } = await this.credentials.rotate(tenant.organizationId, id);
    return { ...credential, rawKey };
  }
}
