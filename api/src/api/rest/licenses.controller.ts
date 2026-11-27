import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { LicenseOrderDto, LicensePlanDto, OrganizationLicenseDto } from '@octap/contracts';
import { LicenseService } from '#domain/licensing/license.service.js';
import { LicenseOrderService } from '#domain/licensing/license-order.service.js';
import { Public } from '#infra/auth/public.decorator.js';
import { Scopes } from '#infra/auth/scopes.decorator.js';
import { Tenant } from '#infra/auth/tenant.decorator.js';
import type { TenantContext } from '#infra/auth/tenant-context.js';
import { ConsoleAccessGuard, PlatformAdminOnly, type ConsoleRequest } from './console-access.guard.js';
import type {
  CreateLicenseOrderBodyDto,
  CreateLicensePlanBodyDto,
  RenewLicenseBodyDto,
  UpdateLicensePlanBodyDto,
} from '../dto/licensing.dto.js';

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
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException('Body must be an object');
    for (const field of ['tier', 'name', 'monthlyPriceVnd', 'entitlements'] as const)
      if (body[field] === undefined) throw new BadRequestException(`${field} is required`);
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
    return this.licenses.readForPlatform(organizationId);
  }
  /** Renews or upgrades by hand: `months` of `planId`, after the latest license (part 3). */
  @Post()
  @Header('Cache-Control', 'no-store')
  renew(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() body: RenewLicenseBodyDto,
  ): Promise<OrganizationLicenseDto> {
    return this.licenses.renew(organizationId, body);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Owner's orders to buy or renew the license (OCT-330). The body names a plan and a term only:
 * the amount is always the plan's, so any other field (an `amount` included) is refused.
 */
@Public()
@UseGuards(ConsoleAccessGuard)
@Controller('v1/console/organizations/:organizationId/license/orders')
export class ConsoleLicenseOrdersController {
  constructor(private readonly orders: LicenseOrderService) {}
  @Post()
  @Header('Cache-Control', 'no-store')
  place(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() body: CreateLicenseOrderBodyDto,
  ): Promise<LicenseOrderDto> {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException('Body must be an object');
    const unknown = Object.keys(body).filter((key) => key !== 'planId' && key !== 'termMonths');
    if (unknown.length) throw new BadRequestException(`Unknown field: ${unknown.join(', ')}`);
    if (typeof body.planId !== 'string' || !UUID.test(body.planId))
      throw new BadRequestException('planId must be a license plan id');
    if (typeof body.termMonths !== 'number' || !Number.isInteger(body.termMonths) || body.termMonths < 1)
      throw new BadRequestException('termMonths must be a whole number of months');
    return this.orders.place(req.consoleIdentity.user.id, organizationId, body.planId, body.termMonths);
  }
  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ): Promise<LicenseOrderDto[]> {
    return this.orders.list(req.consoleIdentity.user.id, organizationId);
  }
  @Get(':orderId')
  @Header('Cache-Control', 'no-store')
  get(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ): Promise<LicenseOrderDto> {
    return this.orders.get(req.consoleIdentity.user.id, organizationId, orderId);
  }
  @Post(':orderId/cancel')
  @Header('Cache-Control', 'no-store')
  cancel(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ): Promise<LicenseOrderDto> {
    return this.orders.cancel(req.consoleIdentity.user.id, organizationId, orderId);
  }
}
