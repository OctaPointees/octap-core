import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Headers,
  BadRequestException,
} from '@nestjs/common';
import { RewardsService } from '../../domain/rewards/rewards.service.js';
import type {
  CreateVoucherBodyDto,
  ClaimVoucherBodyDto,
  RedeemVoucherBodyDto,
} from '../dto/rewards.dto.js';
import type {
  VoucherDto,
  ClaimVoucherResponse,
  RedeemVoucherResponse,
  VoucherOwnershipDto,
} from '@octap/contracts';

@Controller('v1/rewards')
export class RewardsController {
  constructor(private readonly rewardsService: RewardsService) {}

  @Post('vouchers')
  async createVoucher(
    @Headers('x-organization-id') orgHeader: string | undefined,
    @Body() body: CreateVoucherBodyDto,
  ): Promise<VoucherDto> {
    const orgId = orgHeader || '00000000-0000-0000-0000-000000000001';
    if (!body.code || !body.title || !body.discountType) {
      throw new BadRequestException('code, title, and discountType are required');
    }
    return this.rewardsService.createVoucher(orgId, body);
  }

  @Get('vouchers')
  async listVouchers(
    @Headers('x-organization-id') orgHeader: string | undefined,
  ): Promise<VoucherDto[]> {
    const orgId = orgHeader || '00000000-0000-0000-0000-000000000001';
    return this.rewardsService.listVouchers(orgId);
  }

  @Get('vouchers/:id')
  async getVoucher(@Param('id') id: string): Promise<VoucherDto> {
    return this.rewardsService.getVoucher(id);
  }

  @Post('vouchers/:id/claim')
  async claimVoucher(
    @Headers('x-organization-id') orgHeader: string | undefined,
    @Param('id') voucherId: string,
    @Body() body: ClaimVoucherBodyDto,
  ): Promise<ClaimVoucherResponse> {
    const orgId = orgHeader || '00000000-0000-0000-0000-000000000001';
    if (!body.organizationEndUserId) {
      throw new BadRequestException('organizationEndUserId is required');
    }
    return this.rewardsService.claimVoucher(orgId, voucherId, body);
  }

  @Post('vouchers/redeem')
  async redeemVoucher(@Body() body: RedeemVoucherBodyDto): Promise<RedeemVoucherResponse> {
    if (!body.serialCode) {
      throw new BadRequestException('serialCode is required');
    }
    return this.rewardsService.redeemVoucher(body);
  }

  @Get('members/:memberId/vouchers')
  async listMemberVouchers(@Param('memberId') memberId: string): Promise<VoucherOwnershipDto[]> {
    return this.rewardsService.listMemberVouchers(memberId);
  }
}
