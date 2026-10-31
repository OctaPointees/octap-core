import { Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { RewardsRepository, RewardsRuleError } from '#infra/db/repositories/rewards.repository.js';
import { OperationPayloadConflictError } from '#infra/db/repositories/operations.repository.js';
import type { vouchers } from '#infra/db/schema/rewards.schema.js';
import { CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import { PosRedemptionService } from '../credits/pos-redemption.service.js';
import { ProgramsRepository } from '#infra/db/repositories/programs.repository.js';
import { requireProgramConfig } from '../programs/program-config.js';
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

/** postgres-js reports `code` directly; drizzle wraps it in an error whose `cause` carries it. */
function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

/** Maps the repositories' rule errors to the HTTP status a merchant can act on; others pass through. */
function toHttpError(error: unknown): unknown {
  if (error instanceof RewardsRuleError) {
    if (error.kind === 'NOT_FOUND') return new NotFoundException(error.message);
    if (error.kind === 'CONFLICT') return new ConflictException(error.message);
    return new BadRequestException(error.message);
  }
  if (error instanceof OperationPayloadConflictError) return new ConflictException(error.message);
  return error;
}

async function mapErrors<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    throw toHttpError(error);
  }
}

@Injectable()
export class RewardsService {
  constructor(
    private readonly rewardsRepo: RewardsRepository,
    private readonly creditsRepo: CreditsRepository,
    private readonly posRedemption: PosRedemptionService,
    private readonly programsRepo: ProgramsRepository,
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

    const created = await mapErrors(
      this.rewardsRepo.createVoucher({
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
      }),
    );

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
    const voucher = await this.getVoucher(organizationId, voucherId);
    // A retry under an accepted key skips these: it only reports or resumes the existing claim.
    const isNewPaidClaim =
      voucher.pointsCost > 0 && !(await this.creditsRepo.findOperationForClaim(organizationId, key));
    if (isNewPaidClaim) {
      if (!req.idempotencyKey) throw new BadRequestException('idempotencyKey is required for paid voucher claims');
      await requireProgramConfig(this.programsRepo, organizationId);
      if (!(await this.creditsRepo.findBeneficiaryAddress(req.organizationEndUserId)))
        throw new BadRequestException('Member has no linked Sui address');
    }
    let claim: ClaimVoucherResponse;
    try {
      claim = await this.rewardsRepo.claimVoucher(organizationId, voucherId, req.organizationEndUserId, key);
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException('Claim conflicts with an existing operation or voucher ownership');
      throw toHttpError(error);
    }
    if (claim.status !== 'RESERVED' || !claim.transactionId) return claim;

    if (!isNewPaidClaim) await requireProgramConfig(this.programsRepo, organizationId);
    const hold = await this.creditsRepo.findVoucherClaimHold(organizationId, key);
    if (!hold) throw new ConflictException('Claim reservation is missing');
    const sponsored = await this.posRedemption.sponsorReservation(
      organizationId,
      { organizationEndUserId: req.organizationEndUserId, pointsAmount: claim.pointsCost!, idempotencyKey: key },
      hold,
    );
    if (sponsored.status !== 'PENDING') return this.getClaim(organizationId, claim.voucherOwnershipId);
    return { ...claim, digest: sponsored.digest, transactionBytes: sponsored.transactionBytes };
  }

  async getClaim(organizationId: string, ownershipId: string): Promise<ClaimVoucherResponse> {
    return mapErrors(this.rewardsRepo.getClaim(organizationId, ownershipId));
  }

  async redeemVoucher(organizationId: string, req: RedeemVoucherRequest): Promise<RedeemVoucherResponse> {
    if (!req || typeof req.serialCode !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(req.serialCode)) {
      throw new BadRequestException('serialCode must contain 1-100 letters, numbers, underscores or hyphens');
    }
    const { ownership, voucher } = await mapErrors(this.rewardsRepo.redeemVoucher(organizationId, req.serialCode));
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
      if (isUniqueViolation(error)) throw new ConflictException('Voucher code already exists');
      throw toHttpError(error);
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
