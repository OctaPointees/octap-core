import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { RewardsRepository } from '../../infra/db/repositories/rewards.repository.js';
import type { vouchers } from '../../infra/db/schema/rewards.schema.js';
import { RedemptionService } from '../credits/redemption.service.js';
import type {
  CreateVoucherRequest,
  VoucherDto,
  ClaimVoucherRequest,
  ClaimVoucherResponse,
  RedeemVoucherRequest,
  RedeemVoucherResponse,
  VoucherOwnershipDto,
} from '@octap/contracts';

@Injectable()
export class RewardsService {
  constructor(
    private readonly rewardsRepo: RewardsRepository,
    private readonly redemptionService: RedemptionService,
  ) {}

  async createVoucher(organizationId: string, req: CreateVoucherRequest): Promise<VoucherDto> {
    const existing = await this.rewardsRepo.findVoucherByCode(organizationId, req.code);
    if (existing) {
      throw new BadRequestException(`Voucher with code "${req.code}" already exists for this organization`);
    }

    const created = await this.rewardsRepo.createVoucher({
      organizationId,
      code: req.code,
      title: req.title,
      description: req.description,
      pointsCost: req.pointsCost ?? 0,
      discountType: req.discountType,
      discountValue: req.discountValue,
      totalSupply: req.totalSupply,
      startsAt: req.startsAt ? new Date(req.startsAt) : undefined,
      expiresAt: req.expiresAt ? new Date(req.expiresAt) : undefined,
      metadata: req.metadata,
    });

    return this.mapVoucherDto(created);
  }

  async listVouchers(organizationId: string): Promise<VoucherDto[]> {
    const list = await this.rewardsRepo.listVouchersByOrganization(organizationId);
    return list.map((v) => this.mapVoucherDto(v));
  }

  async getVoucher(organizationId: string, voucherId: string): Promise<VoucherDto> {
    const voucher = await this.rewardsRepo.findVoucherById(voucherId);
    if (!voucher || voucher.organizationId !== organizationId) {
      throw new NotFoundException(`Voucher with id ${voucherId} not found`);
    }
    return this.mapVoucherDto(voucher);
  }

  async claimVoucher(
    organizationId: string,
    voucherId: string,
    req: ClaimVoucherRequest,
  ): Promise<ClaimVoucherResponse> {
    const voucher = await this.rewardsRepo.findVoucherById(voucherId);
    if (!voucher || voucher.organizationId !== organizationId) {
      throw new NotFoundException(`Voucher with id ${voucherId} not found`);
    }

    if (voucher.status !== 'ACTIVE') {
      throw new BadRequestException(`Voucher is not active (current status: ${voucher.status})`);
    }

    if (voucher.expiresAt && new Date(voucher.expiresAt) < new Date()) {
      throw new BadRequestException('Voucher has expired');
    }

    const pointsCost = Number(voucher.pointsCost);
    let loyaltyTransactionId: string | undefined;

    // Deduct points if voucher has a point cost
    if (pointsCost > 0) {
      const idempotencyKey = req.idempotencyKey ?? `claim-${voucherId}-${req.organizationEndUserId}-${Date.now()}`;
      const redeemRes = await this.redemptionService.executeRedeem(organizationId, {
        organizationEndUserId: req.organizationEndUserId,
        pointsAmount: pointsCost,
        idempotencyKey,
        receiptReference: `Claim Voucher: ${voucher.code}`,
        metadata: { voucherId: voucher.id, voucherCode: voucher.code },
      });
      loyaltyTransactionId = redeemRes.transactionId;
    }

    const serialCode = `${voucher.code.toUpperCase()}-${randomBytes(4).toString('hex').toUpperCase()}`;

    try {
      const { ownership } = await this.rewardsRepo.claimVoucherInstance({
        voucherId,
        organizationEndUserId: req.organizationEndUserId,
        serialCode,
        loyaltyTransactionId,
      });

      return {
        voucherOwnershipId: ownership.id,
        voucherId: ownership.voucherId,
        organizationEndUserId: ownership.organizationEndUserId,
        serialCode: ownership.serialCode,
        status: ownership.status,
        pointsDeducted: pointsCost,
        claimedAt: ownership.claimedAt.toISOString(),
        expiresAt: ownership.expiresAt?.toISOString() ?? null,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to claim voucher';
      throw new BadRequestException(message);
    }
  }

  async redeemVoucher(organizationId: string, req: RedeemVoucherRequest): Promise<RedeemVoucherResponse> {
    const ownership = await this.rewardsRepo.findOwnershipBySerial(req.serialCode);
    if (!ownership || ownership.voucher.organizationId !== organizationId) {
      throw new NotFoundException(`Voucher with serial code ${req.serialCode} not found`);
    }

    if (ownership.status !== 'AVAILABLE') {
      throw new BadRequestException(`Voucher cannot be used; status is currently ${ownership.status}`);
    }

    if (ownership.expiresAt && new Date(ownership.expiresAt) < new Date()) {
      throw new BadRequestException('Voucher has expired');
    }

    const updated = await this.rewardsRepo.markVoucherRedeemed(ownership.id);

    return {
      voucherOwnershipId: updated.id,
      voucherId: updated.voucherId,
      serialCode: updated.serialCode,
      status: updated.status,
      redeemedAt: updated.redeemedAt?.toISOString() ?? new Date().toISOString(),
      voucherTitle: ownership.voucher.title,
      discountType: ownership.voucher.discountType,
      discountValue: ownership.voucher.discountValue,
    };
  }

  async listMemberVouchers(organizationId: string, organizationEndUserId: string): Promise<VoucherOwnershipDto[]> {
    const ownerships = await this.rewardsRepo.listOwnershipsByMember(organizationEndUserId);
    return ownerships
      .filter((o) => o.voucher.organizationId === organizationId)
      .map((o) => ({
        id: o.id,
        voucherId: o.voucherId,
        organizationEndUserId: o.organizationEndUserId,
        serialCode: o.serialCode,
        status: o.status,
        claimedAt: o.claimedAt.toISOString(),
        redeemedAt: o.redeemedAt?.toISOString() ?? null,
        expiresAt: o.expiresAt?.toISOString() ?? null,
        voucher: this.mapVoucherDto(o.voucher),
      }));
  }

  private mapVoucherDto(voucher: typeof vouchers.$inferSelect): VoucherDto {
    return {
      id: voucher.id,
      organizationId: voucher.organizationId,
      code: voucher.code,
      title: voucher.title,
      description: voucher.description,
      pointsCost: Number(voucher.pointsCost),
      discountType: voucher.discountType,
      discountValue: voucher.discountValue,
      totalSupply: voucher.totalSupply,
      claimedCount: voucher.claimedCount,
      status: voucher.status,
      startsAt: voucher.startsAt ? new Date(voucher.startsAt).toISOString() : null,
      expiresAt: voucher.expiresAt ? new Date(voucher.expiresAt).toISOString() : null,
      metadata: voucher.metadata as Record<string, unknown> | null,
      createdAt: new Date(voucher.createdAt).toISOString(),
      updatedAt: new Date(voucher.updatedAt).toISOString(),
    };
  }
}
