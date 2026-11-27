import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { MembersService } from '#domain/members/members.service.js';
import { Public } from '#infra/auth/public.decorator.js';
import { ConsoleAccessGuard, McpWritable, type ConsoleRequest } from './console-access.guard.js';
import type { LoyaltyTransactionPage, VoucherOwnershipDto } from '@octap/contracts';
import type {
  MemberDirectoryQueryDto,
  MemberProfilePatchBodyDto,
  MemberTransactionQueryDto,
} from '../dto/console.dto.js';
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
    @Query() query: MemberDirectoryQueryDto,
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
  @Get(':memberId/transactions')
  @Header('Cache-Control', 'no-store')
  transactions(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Query() query: MemberTransactionQueryDto,
  ): Promise<LoyaltyTransactionPage> {
    return this.members.transactions(req.consoleIdentity.user.id, orgId, memberId, query);
  }
  @Get(':memberId/vouchers')
  @Header('Cache-Control', 'no-store')
  vouchers(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
  ): Promise<VoucherOwnershipDto[]> {
    return this.members.vouchers(req.consoleIdentity.user.id, orgId, memberId);
  }
  @Patch(':memberId')
  @McpWritable()
  @Header('Cache-Control', 'no-store')
  patch(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() input: MemberProfilePatchBodyDto,
  ) {
    return this.members.patch(req.consoleIdentity.user.id, orgId, memberId, input);
  }
}
