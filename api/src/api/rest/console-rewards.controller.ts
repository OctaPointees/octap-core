import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { VoucherDto } from '@octap/contracts';
import { ConsoleRewardsService } from '#domain/rewards/console-rewards.service.js';
import { Public } from '#infra/auth/public.decorator.js';
import { ConsoleAccessGuard, type ConsoleRequest } from './console-access.guard.js';
import type {
  ConsoleVoucherBodyDto,
  ConsoleVoucherPatchBodyDto,
  VoucherApproveBodyDto,
  VoucherRejectBodyDto,
} from '../dto/console.dto.js';

/**
 * Owner or Business Developer reads and writes drafts; only the Owner pauses, changes a published
 * voucher, and approves or rejects one waiting for approval. See `ConsoleRewardsService`.
 */
@Public()
@UseGuards(ConsoleAccessGuard)
@Controller('v1/console/organizations/:organizationId/vouchers')
export class ConsoleRewardsController {
  constructor(private readonly rewards: ConsoleRewardsService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() req: ConsoleRequest, @Param('organizationId', ParseUUIDPipe) orgId: string): Promise<VoucherDto[]> {
    return this.rewards.list(req.consoleIdentity.user.id, orgId);
  }
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  detail(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VoucherDto> {
    return this.rewards.detail(req.consoleIdentity.user.id, orgId, id);
  }
  @Post()
  @Header('Cache-Control', 'no-store')
  create(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Body() body: ConsoleVoucherBodyDto,
  ): Promise<VoucherDto> {
    return this.rewards.create(req.consoleIdentity.user.id, orgId, body);
  }
  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  update(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ConsoleVoucherPatchBodyDto,
  ): Promise<VoucherDto> {
    return this.rewards.update(req.consoleIdentity.user.id, orgId, id, body);
  }
  @Post(':id/submit')
  @Header('Cache-Control', 'no-store')
  submit(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VoucherDto> {
    return this.rewards.submit(req.consoleIdentity.user.id, orgId, id);
  }
  @Post(':id/withdraw')
  @Header('Cache-Control', 'no-store')
  withdraw(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VoucherDto> {
    return this.rewards.withdraw(req.consoleIdentity.user.id, orgId, id);
  }
  @Post(':id/approve')
  @Header('Cache-Control', 'no-store')
  approve(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: VoucherApproveBodyDto,
  ): Promise<VoucherDto> {
    return this.rewards.approve(req.consoleIdentity.user.id, orgId, id, body);
  }
  @Post(':id/reject')
  @Header('Cache-Control', 'no-store')
  reject(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: VoucherRejectBodyDto,
  ): Promise<VoucherDto> {
    return this.rewards.reject(req.consoleIdentity.user.id, orgId, id, body);
  }
}
