import { Controller, Post, Get, Body, Param, Query, BadRequestException, UseGuards } from '@nestjs/common';
import { CreditsService } from '#domain/credits/credits.service.js';
import { EarnService } from '#domain/credits/earn.service.js';
import { RedemptionService } from '#domain/credits/redemption.service.js';
import { ReversalService } from '#domain/credits/reversal.service.js';
import { PosRedemptionService } from '#domain/credits/pos-redemption.service.js';
import { Public } from '#infra/auth/public.decorator.js';
import { PublicRateLimitGuard } from '#infra/auth/public-rate-limit.guard.js';
import { Scopes } from '#infra/auth/scopes.decorator.js';
import { Tenant } from '#infra/auth/tenant.decorator.js';
import type { TenantContext } from '#infra/auth/tenant-context.js';
import type {
  EarnPointsBodyDto,
  RedeemPointsBodyDto,
  ReverseTransactionBodyDto,
  ReservePosRedemptionBodyDto,
  FinalizePosRedemptionBodyDto,
} from '../dto/credits.dto.js';
import type {
  EarnPointsResponse,
  RedeemPointsResponse,
  CreditBalanceSnapshot,
  LoyaltyTransactionDto,
  ReverseTransactionResponse,
  ReservePosRedemptionResponse,
  FinalizePosRedemptionResponse,
} from '@octap/contracts';

@Controller('v1/credits')
export class CreditsController {
  constructor(
    private readonly creditsService: CreditsService,
    private readonly earnService: EarnService,
    private readonly redemptionService: RedemptionService,
    private readonly reversalService: ReversalService,
    private readonly posRedemptionService: PosRedemptionService,
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

  /**
   * Customer-signed POS redemption. Paid voucher claims share the sponsorship/finalize
   * pipeline after atomically reserving their own stock and points. The merchant initiates;
   * the customer's device signs.
   */
  @Post('redeem/reserve')
  @Scopes('write')
  async reservePosRedemption(
    @Tenant() tenant: TenantContext,
    @Body() body: ReservePosRedemptionBodyDto,
  ): Promise<ReservePosRedemptionResponse> {
    if (!body.organizationEndUserId || !body.pointsAmount || !body.idempotencyKey) {
      throw new BadRequestException('organizationEndUserId, pointsAmount, and idempotencyKey are required');
    }
    return this.posRedemptionService.reserve(tenant.organizationId, body);
  }

  /**
   * `@Public()`, same reasoning as `IdentityController`: the caller here is the customer's own
   * device, which never holds a merchant API credential. The signature over the cached digest is
   * the proof of authorization — Enoki and the chain verify it, not an API key.
   */
  @Public()
  @UseGuards(PublicRateLimitGuard)
  @Post('redeem/finalize')
  async finalizePosRedemption(@Body() body: FinalizePosRedemptionBodyDto): Promise<FinalizePosRedemptionResponse> {
    if (!body.digest || !body.signature) {
      throw new BadRequestException('digest and signature are required');
    }
    return this.posRedemptionService.finalize(body);
  }

  @Post('transactions/:transactionId/reverse')
  @Scopes('write')
  async reverseTransaction(
    @Tenant() tenant: TenantContext,
    @Param('transactionId') transactionId: string,
    @Body() body: ReverseTransactionBodyDto,
  ): Promise<ReverseTransactionResponse> {
    if (!body.idempotencyKey || !body.reason) {
      throw new BadRequestException('idempotencyKey and reason are required');
    }
    return this.reversalService.reverseTransaction(tenant.organizationId, { ...body, transactionId }, tenant);
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
