import { Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { RewardsRepository } from '#infra/db/repositories/rewards.repository.js';
import type { vouchers } from '#infra/db/schema/rewards.schema.js';
import { CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import { validateVoucher } from './voucher-validation.js';
import type {
  CreateVoucherRequest,
  UpdateVoucherRequest,
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
    private readonly creditsRepo: CreditsRepository,
  ) {}

  async createVoucher(organizationId: string, req: CreateVoucherRequest): Promise<VoucherDto> {
    validateVoucher(req);
    const existing = await this.rewardsRepo.findVoucherByCode(organizationId, req.code);
    if (existing) {
      throw new ConflictException(`Voucher with code "${req.code}" already exists for this organization`);
    }
    if ((req.status ?? 'ACTIVE') === 'ACTIVE' && req.expiresAt && Date.parse(req.expiresAt) <= Date.now()) {
      throw new BadRequestException('An expired voucher cannot be activated');
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
      status: req.status,
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
    if (
      !req ||
      typeof req.organizationEndUserId !== 'string' ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(req.organizationEndUserId)
    ) {
      throw new BadRequestException('organizationEndUserId must be a UUID');
    }
    // Stable legacy fallback preserves existing callers; integrations should always supply a key.
    const key = req.idempotencyKey ?? `claim-${voucherId}-${req.organizationEndUserId}`;
    if (typeof key !== 'string' || !/^[a-zA-Z0-9:_-]{1,100}$/.test(key)) {
      throw new BadRequestException(
        'idempotencyKey must contain 1-100 letters, numbers, colons, underscores or hyphens',
      );
    }
    return this.rewardsRepo.claimVoucher(organizationId, voucherId, req.organizationEndUserId, key);
  }

  async redeemVoucher(organizationId: string, req: RedeemVoucherRequest): Promise<RedeemVoucherResponse> {
    if (!req || typeof req.serialCode !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(req.serialCode)) {
      throw new BadRequestException('serialCode must contain 1-100 letters, numbers, underscores or hyphens');
    }
    const { ownership, voucher } = await this.rewardsRepo.redeemVoucher(organizationId, req.serialCode);
    return {
      voucherOwnershipId: ownership.id,
      voucherId: ownership.voucherId,
      serialCode: ownership.serialCode,
      status: ownership.status,
      redeemedAt: ownership.redeemedAt!.toISOString(),
      voucherTitle: voucher.title,
      discountType: voucher.discountType,
      discountValue: voucher.discountValue,
    };
  }

  async updateVoucher(organizationId: string, voucherId: string, req: UpdateVoucherRequest): Promise<VoucherDto> {
    validateVoucher(req, true);
    if (!Object.keys(req).length) throw new BadRequestException('Provide at least one voucher field');
    const { startsAt, expiresAt, ...fields } = req;
    const patch = {
      ...fields,
      ...(startsAt !== undefined ? { startsAt: startsAt === null ? null : new Date(startsAt) } : {}),
      ...(expiresAt !== undefined ? { expiresAt: expiresAt === null ? null : new Date(expiresAt) } : {}),
    };
    try {
      const updated = await this.rewardsRepo.updateVoucher(organizationId, voucherId, patch, (merged) => {
        validateVoucher({
          code: merged.code,
          title: merged.title,
          pointsCost: merged.pointsCost,
          discountType: merged.discountType as CreateVoucherRequest['discountType'],
          discountValue: merged.discountValue ?? undefined,
          totalSupply: merged.totalSupply,
          startsAt: merged.startsAt?.toISOString(),
          expiresAt: merged.expiresAt?.toISOString(),
        });
      });
      return this.mapVoucherDto(updated);
    } catch (error) {
      const e = error as { code?: string; cause?: { code?: string } };
      if (e?.code === '23505' || e?.cause?.code === '23505') throw new ConflictException('Voucher code already exists');
      throw error;
    }
  }

  async listMemberVouchers(organizationId: string, organizationEndUserId: string): Promise<VoucherOwnershipDto[]> {
    const memberOrgId = await this.creditsRepo.findMemberOrganizationId(organizationEndUserId);
    if (memberOrgId !== organizationId) {
      throw new NotFoundException(`Member ${organizationEndUserId} was not found for this organization`);
    }
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
