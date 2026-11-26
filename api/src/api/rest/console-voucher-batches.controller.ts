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
import type { ActivateVoucherBatchBodyDto } from '../dto/console.dto.js';
import type { CreateVoucherBatchBodyDto } from '../dto/rewards.dto.js';
import { RequiresFeature } from '#infra/auth/requires-feature.decorator.js';
import { LicenseFeatureGuard } from './license-feature.guard.js';

/**
 * Voucher batches from the console (OCT-303): the Owner and a Business Developer create, activate and
 * archive them, and only the Owner pauses or resumes one, as for a single voucher. The Owner's
 * activation approves what a Developer's activation sent for approval.
 * See `ConsoleVoucherBatchService`.
 */
@Public()
@UseGuards(ConsoleAccessGuard)
@Controller('v1/console/organizations/:organizationId/voucher-batches')
export class ConsoleVoucherBatchesController {
  constructor(private readonly batches: ConsoleVoucherBatchService) {}

  @Post()
  @RequiresFeature('voucher.batches')
  @UseGuards(LicenseFeatureGuard)
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
  @RequiresFeature('voucher.batches')
  @UseGuards(LicenseFeatureGuard)
  @Header('Cache-Control', 'no-store')
  activate(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @Body() body: ActivateVoucherBatchBodyDto,
  ): Promise<VoucherBatchActionResponse> {
    return this.batches.activate(req.consoleIdentity.user.id, orgId, batchId, body);
  }

  @Post(':batchId/archive')
  @Header('Cache-Control', 'no-store')
  archive(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('batchId', ParseUUIDPipe) batchId: string,
  ): Promise<VoucherBatchActionResponse> {
    return this.batches.archive(req.consoleIdentity.user.id, orgId, batchId);
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
