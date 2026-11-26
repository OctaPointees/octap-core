import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { LicensePlanDto, OrganizationLicenseDto } from '@octap/contracts';
import { LicenseService } from '#domain/licensing/license.service.js';
import { Public } from '#infra/auth/public.decorator.js';
import { Scopes } from '#infra/auth/scopes.decorator.js';
import { Tenant } from '#infra/auth/tenant.decorator.js';
import type { TenantContext } from '#infra/auth/tenant-context.js';
import { ConsoleAccessGuard, PlatformAdminOnly, type ConsoleRequest } from './console-access.guard.js';
import type { CreateLicensePlanBodyDto, UpdateLicensePlanBodyDto } from '../dto/licensing.dto.js';

/** The organization's license and usage, for its Owner and Business Developers (OCT-329). */
@Public()
@UseGuards(ConsoleAccessGuard)
@Controller('v1/console/organizations/:organizationId/license')
export class ConsoleLicenseController {
  constructor(private readonly licenses: LicenseService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  read(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ): Promise<OrganizationLicenseDto> {
    return this.licenses.readAsMember(req.consoleIdentity.user.id, organizationId);
  }
}

/** The plans an Owner can buy: active and purchasable. Any signed-in console user may read them. */
@Public()
@UseGuards(ConsoleAccessGuard)
@Controller('v1/console/license-plans')
export class ConsoleLicensePlansController {
  constructor(private readonly licenses: LicenseService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  list(): Promise<LicensePlanDto[]> {
    return this.licenses.listOffered();
  }
}

/** The organization's license and usage, for its own server with a `read` key. */
@Controller('v1/license')
export class LicenseController {
  constructor(private readonly licenses: LicenseService) {}
  @Get()
  @Scopes('read')
  read(@Tenant() tenant: TenantContext): Promise<OrganizationLicenseDto> {
    return this.licenses.read(tenant.organizationId);
  }
}

/** The plan catalogue, managed by the System Admin. Plans are never deleted, only made inactive. */
@Public()
@UseGuards(ConsoleAccessGuard)
@PlatformAdminOnly()
@Controller('v1/platform/license-plans')
export class PlatformLicensePlansController {
  constructor(private readonly licenses: LicenseService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  list(): Promise<LicensePlanDto[]> {
    return this.licenses.listAll();
  }
  @Post()
  @Header('Cache-Control', 'no-store')
  create(@Body() body: CreateLicensePlanBodyDto): Promise<LicensePlanDto> {
    return this.licenses.createPlan(body);
  }
  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateLicensePlanBodyDto): Promise<LicensePlanDto> {
    return this.licenses.updatePlan(id, body);
  }
}

/** Any organization's license and usage, for the System Admin. */
@Public()
@UseGuards(ConsoleAccessGuard)
@PlatformAdminOnly()
@Controller('v1/platform/organizations/:organizationId/license')
export class PlatformOrganizationLicenseController {
  constructor(private readonly licenses: LicenseService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  read(@Param('organizationId', ParseUUIDPipe) organizationId: string): Promise<OrganizationLicenseDto> {
    return this.licenses.read(organizationId);
  }
}
