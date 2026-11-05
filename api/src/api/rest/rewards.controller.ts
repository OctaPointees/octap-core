import {
  Controller,
  Post,
  Get,
  Put,
  Patch,
  Query,
  ParseIntPipe,
  Body,
  Param,
  ParseUUIDPipe,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import type { SetVoucherRefundPolicyRequest } from '@octap/contracts';
import { RefundPolicyService } from '#domain/rewards/refund-policy.service.js';
import { RewardsService } from '#domain/rewards/rewards.service.js';
import { VoucherUseService } from '#domain/rewards/voucher-use.service.js';
import { Public } from '#infra/auth/public.decorator.js';
import { PublicRateLimitGuard } from '#infra/auth/public-rate-limit.guard.js';
import { Scopes } from '#infra/auth/scopes.decorator.js';
import { Tenant } from '#infra/auth/tenant.decorator.js';
import type { TenantContext } from '#infra/auth/tenant-context.js';
import type {
  CreateVoucherBodyDto,
  UpdateVoucherBodyDto,
  ClaimVoucherBodyDto,
  GrantVoucherBodyDto,
  PrepareVoucherUseBodyDto,
  FinalizeVoucherUseBodyDto,
} from '../dto/rewards.dto.js';
import type {
  VoucherDto,
  ClaimVoucherResponse,
  RedeemVoucherResponse,
  VoucherOwnershipDto,
  PrepareVoucherUseResponse,
} from '@octap/contracts';

@Controller('v1/rewards')
export class RewardsController {
  constructor(
    private readonly rewardsService: RewardsService,
    private readonly voucherUseService: VoucherUseService,
    private readonly refundPolicy: RefundPolicyService,
  ) {}

  @Get('refund-policy')
  @Scopes('read')
  getRefundPolicy(@Tenant() tenant: TenantContext) {
    return this.refundPolicy.current(tenant.organizationId);
  }

  @Get('refund-policy/history')
  @Scopes('admin')
  getRefundPolicyHistory(
    @Tenant() tenant: TenantContext,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('beforeVersion', new ParseIntPipe({ optional: true })) beforeVersion?: number,
  ) {
    return this.refundPolicy.history(tenant.organizationId, { limit, beforeVersion });
  }

  @Put('refund-policy')
  @Scopes('admin')
  setRefundPolicy(@Tenant() tenant: TenantContext, @Body() body: SetVoucherRefundPolicyRequest) {
    return this.refundPolicy.publish(tenant.organizationId, tenant.credentialId, body);
  }

  @Post('vouchers')
  @Scopes('write')
  async createVoucher(@Tenant() tenant: TenantContext, @Body() body: CreateVoucherBodyDto): Promise<VoucherDto> {
    if (!body?.code || !body.title || (!body.discountType && !body.terms)) {
      throw new BadRequestException('code, title, and either discountType or terms are required');
    }
    return this.rewardsService.createVoucher(tenant.organizationId, body);
  }

  @Get('vouchers')
  @Scopes('read')
  async listVouchers(@Tenant() tenant: TenantContext): Promise<VoucherDto[]> {
    return this.rewardsService.listVouchers(tenant.organizationId);
  }

  @Get('vouchers/:id')
  @Scopes('read')
  async getVoucher(@Tenant() tenant: TenantContext, @Param('id', new ParseUUIDPipe()) id: string): Promise<VoucherDto> {
    return this.rewardsService.getVoucher(tenant.organizationId, id);
  }

  @Patch('vouchers/:id')
  @Scopes('write')
  async updateVoucher(
    @Tenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateVoucherBodyDto,
  ): Promise<VoucherDto> {
    return this.rewardsService.updateVoucher(tenant.organizationId, id, body);
  }

  @Post('vouchers/:id/claim')
  @Scopes('write')
  async claimVoucher(
    @Tenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) voucherId: string,
    @Body() body: ClaimVoucherBodyDto,
  ): Promise<ClaimVoucherResponse> {
    if (!body?.organizationEndUserId) {
      throw new BadRequestException('organizationEndUserId is required');
    }
    return this.rewardsService.claimVoucher(tenant.organizationId, voucherId, body);
  }

  @Get('claims/:id')
  @Scopes('read')
  async getClaim(
    @Tenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ClaimVoucherResponse> {
    return this.rewardsService.getClaim(tenant.organizationId, id);
  }

  /** Gives a customer a voucher without spending their points. */
  @Post('vouchers/:id/grant')
  @Scopes('write')
  async grantVoucher(
    @Tenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) voucherId: string,
    @Body() body: GrantVoucherBodyDto,
  ): Promise<ClaimVoucherResponse> {
    if (!body?.organizationEndUserId || !body.idempotencyKey) {
      throw new BadRequestException('organizationEndUserId and idempotencyKey are required');
    }
    return this.rewardsService.grantVoucher(tenant.organizationId, voucherId, body);
  }

  /** Returns bytes for the customer to sign. An API key alone cannot mark a voucher used. */
  @Post('vouchers/use')
  @Scopes('write')
  async prepareVoucherUse(
    @Tenant() tenant: TenantContext,
    @Body() body: PrepareVoucherUseBodyDto,
  ): Promise<PrepareVoucherUseResponse> {
    if (!body?.serialCode || !body.idempotencyKey) {
      throw new BadRequestException('serialCode and idempotencyKey are required');
    }
    return this.voucherUseService.prepare(tenant.organizationId, body);
  }

  /**
   * `@Public()`, same reasoning as `POST /v1/credits/redeem/finalize`: the caller is the customer's
   * own device, and the signature over the cached digest is the proof of authorization.
   */
  @Public()
  @UseGuards(PublicRateLimitGuard)
  @Post('vouchers/use/finalize')
  async finalizeVoucherUse(@Body() body: FinalizeVoucherUseBodyDto): Promise<RedeemVoucherResponse> {
    if (!body?.digest || !body.signature) {
      throw new BadRequestException('digest and signature are required');
    }
    return this.voucherUseService.finalize(body);
  }

  @Get('members/:memberId/vouchers')
  @Scopes('read')
  async listMemberVouchers(
    @Tenant() tenant: TenantContext,
    @Param('memberId', new ParseUUIDPipe()) memberId: string,
  ): Promise<VoucherOwnershipDto[]> {
    return this.rewardsService.listMemberVouchers(tenant.organizationId, memberId);
  }
}
