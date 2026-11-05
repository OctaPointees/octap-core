import { Controller, Get, Header, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import type { IssuanceBudgetDto } from '@octap/contracts';
import { IssuanceBudgetService } from '#domain/credits/issuance-budget.service.js';
import { Public } from '#infra/auth/public.decorator.js';
import { ConsoleAccessGuard, PlatformAdminOnly, type ConsoleRequest } from './console-access.guard.js';

@Public()
@UseGuards(ConsoleAccessGuard)
@Controller('v1/console/organizations/:organizationId/budget')
export class ConsoleIssuanceBudgetController {
  constructor(private readonly budget: IssuanceBudgetService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  read(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ): Promise<IssuanceBudgetDto> {
    return this.budget.readAsMember(req.consoleIdentity.user.id, organizationId);
  }
}

@Public()
@UseGuards(ConsoleAccessGuard)
@PlatformAdminOnly()
@Controller('v1/platform/organizations/:organizationId/budget')
export class PlatformIssuanceBudgetController {
  constructor(private readonly budget: IssuanceBudgetService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  read(@Param('organizationId', ParseUUIDPipe) organizationId: string): Promise<IssuanceBudgetDto> {
    return this.budget.read(organizationId);
  }
}
