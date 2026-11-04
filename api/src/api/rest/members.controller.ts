import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { MembersService } from '#domain/members/members.service.js';
import { Public } from '#infra/auth/public.decorator.js';
import { ConsoleAccessGuard, type ConsoleRequest } from './console-access.guard.js';
@Public()
@UseGuards(ConsoleAccessGuard)
@Controller('v1/console/organizations/:organizationId/members')
export class MembersController {
  constructor(private readonly members: MembersService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.members.list(req.consoleIdentity.user.id, orgId, query);
  }
  @Get(':memberId')
  @Header('Cache-Control', 'no-store')
  detail(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
  ) {
    return this.members.detail(req.consoleIdentity.user.id, orgId, memberId);
  }
  @Patch(':memberId')
  @Header('Cache-Control', 'no-store')
  patch(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() input: Record<string, unknown>,
  ) {
    return this.members.patch(req.consoleIdentity.user.id, orgId, memberId, input);
  }
}
