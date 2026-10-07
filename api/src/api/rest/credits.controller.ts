import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Headers,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { CreditsService } from '../../domain/credits/credits.service.js';
import { EarnService } from '../../domain/credits/earn.service.js';
import { RedemptionService } from '../../domain/credits/redemption.service.js';
import type { EarnPointsBodyDto, RedeemPointsBodyDto } from '../dto/credits.dto.js';
import type {
  EarnPointsResponse,
  RedeemPointsResponse,
  CreditBalanceSnapshot,
  LoyaltyTransactionDto,
} from '@octap/contracts';

@Controller('v1/credits')
export class CreditsController {
  constructor(
    private readonly creditsService: CreditsService,
    private readonly earnService: EarnService,
    private readonly redemptionService: RedemptionService,
  ) {}

  @Post('earn')
  async earn(
    @Headers('x-organization-id') orgHeader: string | undefined,
    @Body() body: EarnPointsBodyDto,
  ): Promise<EarnPointsResponse> {
    const orgId = orgHeader || '00000000-0000-0000-0000-000000000001';
    if (!body.organizationEndUserId || !body.pointsAmount || !body.idempotencyKey) {
      throw new BadRequestException('organizationEndUserId, pointsAmount, and idempotencyKey are required');
    }
    return this.earnService.executeEarn(orgId, body);
  }

  @Post('redeem')
  async redeem(
    @Headers('x-organization-id') orgHeader: string | undefined,
    @Body() body: RedeemPointsBodyDto,
  ): Promise<RedeemPointsResponse> {
    const orgId = orgHeader || '00000000-0000-0000-0000-000000000001';
    if (!body.organizationEndUserId || !body.pointsAmount || !body.idempotencyKey) {
      throw new BadRequestException('organizationEndUserId, pointsAmount, and idempotencyKey are required');
    }
    return this.redemptionService.executeRedeem(orgId, body);
  }

  @Get('members/:memberId/balance')
  async getBalance(@Param('memberId') memberId: string): Promise<CreditBalanceSnapshot> {
    return this.creditsService.getBalance(memberId);
  }

  @Get('members/:memberId/transactions')
  async getTransactions(
    @Param('memberId') memberId: string,
    @Query('limit') limit?: string,
  ): Promise<LoyaltyTransactionDto[]> {
    return this.creditsService.listTransactions(memberId, limit ? Number(limit) : 50);
  }
}
