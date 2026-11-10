import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AdministrationService } from '#domain/administration/administration.service.js';
import { Public } from '#infra/auth/public.decorator.js';
import { ConsoleAccessGuard, PlatformAdminOnly, type ConsoleRequest } from './console-access.guard.js';
import type {
  GovernanceProposalBodyDto,
  GovernanceRequestListQueryDto,
  ReviewDecisionBodyDto,
} from '../dto/console.dto.js';
@Public()
@UseGuards(ConsoleAccessGuard)
@Controller('v1/console/organizations/:organizationId/change-requests')
export class ConsoleChangeRequestsController {
  constructor(private readonly administration: AdministrationService) {}
  @Post()
  @Header('Cache-Control', 'no-store')
  propose(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Body() body: GovernanceProposalBodyDto,
  ) {
    return this.administration.propose(req.consoleIdentity.user.id, orgId, body, false);
  }
}
@Public()
@UseGuards(ConsoleAccessGuard)
@PlatformAdminOnly()
@Controller('v1/platform')
export class PlatformChangeRequestsController {
  constructor(private readonly administration: AdministrationService) {}
  @Get('change-requests')
  @Header('Cache-Control', 'no-store')
  list(@Req() req: ConsoleRequest, @Query() query: GovernanceRequestListQueryDto) {
    return this.administration.list(req.consoleIdentity.user.id, query);
  }
  @Post('organizations/:organizationId/change-requests')
  @Header('Cache-Control', 'no-store')
  propose(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Body() body: GovernanceProposalBodyDto,
  ) {
    return this.administration.propose(req.consoleIdentity.user.id, orgId, body, true);
  }
  @Post('change-requests/:id/approve')
  @Header('Cache-Control', 'no-store')
  approve(@Req() req: ConsoleRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReviewDecisionBodyDto) {
    return this.administration.decide(req.consoleIdentity.user.id, id, true, body?.reason);
  }
  @Post('change-requests/:id/reject')
  @Header('Cache-Control', 'no-store')
  reject(@Req() req: ConsoleRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReviewDecisionBodyDto) {
    return this.administration.decide(req.consoleIdentity.user.id, id, false, body?.reason);
  }
}
