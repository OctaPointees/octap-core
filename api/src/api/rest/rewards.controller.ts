import { Controller, Post, Get, Patch, Body, Param, ParseUUIDPipe, BadRequestException } from '@nestjs/common';
import { RewardsService } from '#domain/rewards/rewards.service.js';
import { Scopes } from '#infra/auth/scopes.decorator.js';
import { Tenant } from '#infra/auth/tenant.decorator.js';
import type { TenantContext } from '#infra/auth/tenant-context.js';
import type {
  CreateVoucherBodyDto,
  UpdateVoucherBodyDto,
  ClaimVoucherBodyDto,
  RedeemVoucherBodyDto,
} from '../dto/rewards.dto.js';
import type { VoucherDto, ClaimVoucherResponse, RedeemVoucherResponse, VoucherOwnershipDto } from '@octap/contracts';

@Controller('v1/rewards')
export class RewardsController {
  constructor(private readonly rewardsService: RewardsService) {}

  @Post('vouchers')
  @Scopes('write')
  async createVoucher(@Tenant() tenant: TenantContext, @Body() body: CreateVoucherBodyDto): Promise<VoucherDto> {
    if (!body?.code || !body.title || !body.discountType) {
      throw new BadRequestException('code, title, and discountType are required');
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

  @Post('vouchers/redeem')
  @Scopes('write')
  async redeemVoucher(
    @Tenant() tenant: TenantContext,
    @Body() body: RedeemVoucherBodyDto,
  ): Promise<RedeemVoucherResponse> {
    if (!body?.serialCode) {
      throw new BadRequestException('serialCode is required');
    }
    return this.rewardsService.redeemVoucher(tenant.organizationId, body);
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
