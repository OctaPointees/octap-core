import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import type {
  CreateVoucherBatchResponse,
  VoucherBatchActionResponse,
  VoucherBatchDetailDto,
  VoucherBatchDto,
} from '@octap/contracts';
import { ConsoleVoucherBatchService } from '#domain/rewards/console-rewards.service.js';
import { Public } from '#infra/auth/public.decorator.js';
import { ConsoleAccessGuard, type ConsoleRequest } from './console-access.guard.js';
import type { CreateVoucherBatchBodyDto, RejectVoucherBatchBodyDto } from '../dto/rewards.dto.js';

/**
 * Voucher batches from the console (OCT-303): the Owner and a Business Developer create, activate and
 * archive them; only the Owner approves, rejects, pauses or resumes a batch, as for a single voucher.
 * See `ConsoleVoucherBatchService`.
 */
@Public()
@UseGuards(ConsoleAccessGuard)
@Controller('v1/console/organizations/:organizationId/voucher-batches')
export class ConsoleVoucherBatchesController {
  constructor(private readonly batches: ConsoleVoucherBatchService) {}

  @Post()
  @Header('Cache-Control', 'no-store')
  create(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Body() body: CreateVoucherBatchBodyDto,
  ): Promise<CreateVoucherBatchResponse> {
    return this.batches.create(req.consoleIdentity.user.id, orgId, body);
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Query('includeArchived') includeArchived?: 'true' | 'false',
  ): Promise<VoucherBatchDto[]> {
    return this.batches.list(req.consoleIdentity.user.id, orgId, includeArchived);
  }

  @Get(':batchId')
  @Header('Cache-Control', 'no-store')
  detail(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('batchId', ParseUUIDPipe) batchId: string,
  ): Promise<VoucherBatchDetailDto> {
    return this.batches.detail(req.consoleIdentity.user.id, orgId, batchId);
  }

  @Post(':batchId/activate')
  @Header('Cache-Control', 'no-store')
  activate(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('batchId', ParseUUIDPipe) batchId: string,
  ): Promise<VoucherBatchActionResponse> {
    return this.batches.activate(req.consoleIdentity.user.id, orgId, batchId);
  }

  @Post(':batchId/archive')
  @Header('Cache-Control', 'no-store')
  archive(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('batchId', ParseUUIDPipe) batchId: string,
  ): Promise<VoucherBatchDto> {
    return this.batches.archive(req.consoleIdentity.user.id, orgId, batchId);
  }

  @Post(':batchId/approve')
  @Header('Cache-Control', 'no-store')
  approve(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('batchId', ParseUUIDPipe) batchId: string,
  ): Promise<VoucherBatchActionResponse> {
    return this.batches.approve(req.consoleIdentity.user.id, orgId, batchId);
  }

  @Post(':batchId/reject')
  @Header('Cache-Control', 'no-store')
  reject(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @Body() body: RejectVoucherBatchBodyDto,
  ): Promise<VoucherBatchActionResponse> {
    return this.batches.reject(req.consoleIdentity.user.id, orgId, batchId, body);
  }

  @Post(':batchId/pause')
  @Header('Cache-Control', 'no-store')
  pause(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('batchId', ParseUUIDPipe) batchId: string,
  ): Promise<VoucherBatchActionResponse> {
    return this.batches.setPaused(req.consoleIdentity.user.id, orgId, batchId, true);
  }

  @Post(':batchId/resume')
  @Header('Cache-Control', 'no-store')
  resume(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('batchId', ParseUUIDPipe) batchId: string,
  ): Promise<VoucherBatchActionResponse> {
    return this.batches.setPaused(req.consoleIdentity.user.id, orgId, batchId, false);
  }
}
