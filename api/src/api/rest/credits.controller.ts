import { Controller, Post, Get, Body, Param, Query, BadRequestException } from '@nestjs/common';
import { CreditsService } from '../../domain/credits/credits.service.js';
import { EarnService } from '../../domain/credits/earn.service.js';
import { RedemptionService } from '../../domain/credits/redemption.service.js';
import { Scopes } from '../../infra/auth/scopes.decorator.js';
import { Tenant } from '../../infra/auth/tenant.decorator.js';
import type { TenantContext } from '../../infra/auth/tenant-context.js';
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
  @Scopes('write')
  async earn(@Tenant() tenant: TenantContext, @Body() body: EarnPointsBodyDto): Promise<EarnPointsResponse> {
    if (!body.organizationEndUserId || !body.pointsAmount || !body.idempotencyKey) {
      throw new BadRequestException('organizationEndUserId, pointsAmount, and idempotencyKey are required');
    }
    return this.earnService.executeEarn(tenant.organizationId, body);
  }

  @Post('redeem')
  @Scopes('write')
  async redeem(@Tenant() tenant: TenantContext, @Body() body: RedeemPointsBodyDto): Promise<RedeemPointsResponse> {
    if (!body.organizationEndUserId || !body.pointsAmount || !body.idempotencyKey) {
      throw new BadRequestException('organizationEndUserId, pointsAmount, and idempotencyKey are required');
    }
    return this.redemptionService.executeRedeem(tenant.organizationId, body);
  }

  @Get('members/:memberId/balance')
  @Scopes('read')
  async getBalance(
    @Tenant() tenant: TenantContext,
    @Param('memberId') memberId: string,
  ): Promise<CreditBalanceSnapshot> {
    return this.creditsService.getBalance(tenant.organizationId, memberId);
  }

  @Get('members/:memberId/transactions')
  @Scopes('read')
  async getTransactions(
    @Tenant() tenant: TenantContext,
    @Param('memberId') memberId: string,
    @Query('limit') limit?: string,
  ): Promise<LoyaltyTransactionDto[]> {
    return this.creditsService.listTransactions(tenant.organizationId, memberId, limit ? Number(limit) : 50);
  }
}
