import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import type {
  ActivateVoucherBatchResponse,
  CreateVoucherBatchResponse,
  VoucherBatchDetailDto,
  VoucherBatchDto,
} from '@octap/contracts';
import { ConsoleVoucherBatchService } from '#domain/rewards/console-rewards.service.js';
import { Public } from '#infra/auth/public.decorator.js';
import { ConsoleAccessGuard, type ConsoleRequest } from './console-access.guard.js';
import type { CreateVoucherBatchBodyDto } from '../dto/rewards.dto.js';

/**
 * Voucher batches from the console (OCT-303): the Owner and a Business Developer, with the same rules
 * as single vouchers. See `ConsoleVoucherBatchService`.
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
  ): Promise<ActivateVoucherBatchResponse> {
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
}
