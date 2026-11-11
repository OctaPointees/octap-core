import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Public } from '#infra/auth/public.decorator.js';
import { ConsoleOrganizationsService } from '#domain/identity/console-organizations.service.js';
import { ConsoleAccessGuard, PlatformAdminOnly, type ConsoleRequest } from './console-access.guard.js';
import type {
  ConsoleInvitationBodyDto,
  ConsoleStaffAccessBodyDto,
  OrganizationApplicationBodyDto,
  OrganizationProfileBodyDto,
  ReviewDecisionBodyDto,
} from '../dto/console.dto.js';

@Public()
@UseGuards(ConsoleAccessGuard)
@Controller('v1/console')
export class ConsoleOrganizationsController {
  constructor(private readonly organizations: ConsoleOrganizationsService) {}
  @Post('organization-requests')
  @Header('Cache-Control', 'no-store')
  apply(@Req() request: ConsoleRequest, @Body() body: OrganizationApplicationBodyDto) {
    return this.organizations.apply(request.consoleIdentity.user.id, body);
  }
  @Get('organization-requests')
  @Header('Cache-Control', 'no-store')
  applications(@Req() request: ConsoleRequest) {
    return this.organizations.applications(request.consoleIdentity.user.id);
  }
  @Get('organizations/:organizationId')
  @Header('Cache-Control', 'no-store')
  organization(@Req() request: ConsoleRequest, @Param('organizationId', ParseUUIDPipe) orgId: string) {
    return this.organizations.organization(request.consoleIdentity.user.id, orgId);
  }
  @Patch('organizations/:organizationId/profile')
  profile(
    @Req() request: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Body() body: OrganizationProfileBodyDto,
  ) {
    return this.organizations.profile(request.consoleIdentity.user.id, orgId, body);
  }
  @Get('organizations/:organizationId/staff')
  @Header('Cache-Control', 'no-store')
  staff(@Req() request: ConsoleRequest, @Param('organizationId', ParseUUIDPipe) orgId: string) {
    return this.organizations.staff(request.consoleIdentity.user.id, orgId);
  }
  @Patch('organizations/:organizationId/staff/:userId')
  @Header('Cache-Control', 'no-store')
  staffAccess(
    @Req() request: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: ConsoleStaffAccessBodyDto,
  ) {
    return this.organizations.staffAccess(request.consoleIdentity.user.id, orgId, userId, body);
  }
  @Post('organizations/:organizationId/invitations')
  @Header('Cache-Control', 'no-store')
  invite(
    @Req() request: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Body() body: ConsoleInvitationBodyDto,
  ) {
    return this.organizations.invite(request.consoleIdentity.user.id, orgId, body);
  }
  @Get('organizations/:organizationId/invitations')
  @Header('Cache-Control', 'no-store')
  invitations(@Req() request: ConsoleRequest, @Param('organizationId', ParseUUIDPipe) orgId: string) {
    return this.organizations.invitationList(request.consoleIdentity.user.id, orgId);
  }
  @Post('organizations/:organizationId/invitations/:id/revoke')
  @Header('Cache-Control', 'no-store')
  revoke(
    @Req() request: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.organizations.revoke(request.consoleIdentity.user.id, orgId, id);
  }
  @Post('invitations/:token/accept')
  @Header('Cache-Control', 'no-store')
  accept(@Req() request: ConsoleRequest, @Param('token') token: string) {
    return this.organizations.accept(request.consoleIdentity, token);
  }
}

@Public()
@UseGuards(ConsoleAccessGuard)
@PlatformAdminOnly()
@Controller('v1/platform/organization-requests')
export class PlatformOrganizationRequestsController {
  constructor(private readonly organizations: ConsoleOrganizationsService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() request: ConsoleRequest) {
    return this.organizations.applications(request.consoleIdentity.user.id, true);
  }
  @Post(':id/approve')
  @Header('Cache-Control', 'no-store')
  approve(@Req() request: ConsoleRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReviewDecisionBodyDto) {
    return this.organizations.decide(request.consoleIdentity.user.id, id, true, body?.reason);
  }
  @Post(':id/reject')
  @Header('Cache-Control', 'no-store')
  reject(@Req() request: ConsoleRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReviewDecisionBodyDto) {
    return this.organizations.decide(request.consoleIdentity.user.id, id, false, body?.reason);
  }
}

@Public()
@UseGuards(ConsoleAccessGuard)
@PlatformAdminOnly()
@Controller('v1/platform/organizations')
export class PlatformOrganizationOwnersController {
  constructor(private readonly organizations: ConsoleOrganizationsService) {}
  @Post(':organizationId/owner')
  @Header('Cache-Control', 'no-store')
  bootstrap(
    @Req() request: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Body('systemUserId', ParseUUIDPipe) userId: string,
  ) {
    return this.organizations.bootstrapOwner(request.consoleIdentity.user.id, orgId, userId);
  }
}
