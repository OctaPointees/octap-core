import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type {
  CreateVoucherBatchResponse,
  VoucherBatchActionResponse,
  VoucherBatchDetailDto,
  VoucherBatchDto,
} from '@octap/contracts';
import { VoucherBatchService } from '#domain/rewards/voucher-batch.service.js';
import { Scopes } from '#infra/auth/scopes.decorator.js';
import { Tenant } from '#infra/auth/tenant.decorator.js';
import type { TenantContext } from '#infra/auth/tenant-context.js';
import type { CreateVoucherBatchBodyDto } from '../dto/rewards.dto.js';

/**
 * Voucher batches with a merchant API key (OCT-303): create many vouchers as one DRAFT batch (with
 * `dryRun` to preview), then activate, pause, resume or archive the batch. Approving or rejecting a
 * batch is the Owner's, in the console only, as for a single voucher. The console has the same routes for the
 * Owner and a Business Developer (`ConsoleVoucherBatchesController`).
 */
@Controller('v1/rewards/voucher-batches')
export class VoucherBatchesController {
  constructor(private readonly batches: VoucherBatchService) {}

  @Post()
  @Scopes('write')
  create(
    @Tenant() tenant: TenantContext,
    @Body() body: CreateVoucherBatchBodyDto,
  ): Promise<CreateVoucherBatchResponse> {
    return this.batches.create(tenant.organizationId, body, { role: 'CREDENTIAL', credentialId: tenant.credentialId });
  }

  @Get()
  @Scopes('read')
  list(
    @Tenant() tenant: TenantContext,
    @Query('includeArchived') includeArchived?: 'true' | 'false',
  ): Promise<VoucherBatchDto[]> {
    return this.batches.list(tenant.organizationId, includeArchived);
  }

  @Get(':batchId')
  @Scopes('read')
  detail(
    @Tenant() tenant: TenantContext,
    @Param('batchId', new ParseUUIDPipe()) batchId: string,
  ): Promise<VoucherBatchDetailDto> {
    return this.batches.get(tenant.organizationId, batchId);
  }

  @Post(':batchId/activate')
  @Scopes('write')
  activate(
    @Tenant() tenant: TenantContext,
    @Param('batchId', new ParseUUIDPipe()) batchId: string,
  ): Promise<VoucherBatchActionResponse> {
    return this.batches.activate(tenant.organizationId, batchId, {
      role: 'CREDENTIAL',
      credentialId: tenant.credentialId,
    });
  }

  @Post(':batchId/archive')
  @Scopes('write')
  archive(
    @Tenant() tenant: TenantContext,
    @Param('batchId', new ParseUUIDPipe()) batchId: string,
  ): Promise<VoucherBatchDto> {
    return this.batches.archive(tenant.organizationId, batchId);
  }

  /** Pauses every voucher of the batch that is on-chain, as `PATCH { status: 'PAUSED' }` does for one. */
  @Post(':batchId/pause')
  @Scopes('write')
  pause(
    @Tenant() tenant: TenantContext,
    @Param('batchId', new ParseUUIDPipe()) batchId: string,
  ): Promise<VoucherBatchActionResponse> {
    return this.batches.setPaused(tenant.organizationId, batchId, true, {
      role: 'CREDENTIAL',
      credentialId: tenant.credentialId,
    });
  }

  /** Resumes every paused voucher of the batch that is published; resuming needs no approval. */
  @Post(':batchId/resume')
  @Scopes('write')
  resume(
    @Tenant() tenant: TenantContext,
    @Param('batchId', new ParseUUIDPipe()) batchId: string,
  ): Promise<VoucherBatchActionResponse> {
    return this.batches.setPaused(tenant.organizationId, batchId, false, {
      role: 'CREDENTIAL',
      credentialId: tenant.credentialId,
    });
  }
}
