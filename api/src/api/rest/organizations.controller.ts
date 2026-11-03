import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { OrganizationsService } from '#domain/organizations/organizations.service.js';
import { Public } from '#infra/auth/public.decorator.js';
import { ConsoleAccessGuard, PlatformAdminOnly, type ConsoleRequest } from './console-access.guard.js';
@Public()
@UseGuards(ConsoleAccessGuard)
@PlatformAdminOnly()
@Controller('v1/platform')
export class PlatformOrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}
  @Get('organizations')
  @Header('Cache-Control', 'no-store')
  list(@Req() req: ConsoleRequest, @Query() query: Record<string, unknown>) {
    return this.organizations.list(req.consoleIdentity.user.id, query);
  }
  @Get('organizations/:id')
  @Header('Cache-Control', 'no-store')
  detail(@Req() req: ConsoleRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.organizations.detail(req.consoleIdentity.user.id, id);
  }
  @Post('organizations')
  @Header('Cache-Control', 'no-store')
  create(@Req() req: ConsoleRequest, @Body() input: Record<string, unknown>) {
    return this.organizations.create(req.consoleIdentity.user.id, input);
  }
  @Get('owner-candidates')
  @Header('Cache-Control', 'no-store')
  owners(@Req() req: ConsoleRequest, @Query('q') query: unknown) {
    return this.organizations.owners(req.consoleIdentity.user.id, query);
  }
  @Post('organizations/:id/provision')
  @Header('Cache-Control', 'no-store')
  provision(
    @Req() req: ConsoleRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: Record<string, unknown>,
  ) {
    return this.organizations.provision(req.consoleIdentity.user.id, id, input);
  }
}
@Public()
@Controller('v1/organizations')
export class OrganizationResolutionController {
  constructor(private readonly organizations: OrganizationsService) {}
  @Get('resolve/:slug')
  @Header('Cache-Control', 'no-store')
  resolve(@Param('slug') slug: string) {
    return this.organizations.resolve(slug);
  }
}
