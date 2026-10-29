import { describe, expect, it, vi } from 'vitest';
import { RewardsService } from '#domain/rewards/rewards.service.js';
import type { RewardsRepository } from '#infra/db/repositories/rewards.repository.js';
import type { RedemptionService } from '#domain/credits/redemption.service.js';
import type { CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import { stub } from '../../../helpers/stub.js';
import { buildVoucher } from '../../../helpers/fixtures.js';

const sameOrgMember = stub<CreditsRepository>({ findMemberOrganizationId: async () => 'org-1' });
const crossTenantMember = stub<CreditsRepository>({
  findMemberOrganizationId: async (id: string) => (id === 'user-org1' ? 'org-1' : 'org-2'),
});

function ownership(overrides: Record<string, unknown> = {}) {
  return {
    id: 'own-1',
    voucherId: 'v-1',
    organizationEndUserId: 'user-1',
    serialCode: 'DISCOUNT10-ABCD1234',
    status: 'AVAILABLE',
    claimedAt: new Date('2026-10-02T00:00:00Z'),
    redeemedAt: null,
    expiresAt: null,
    voucher: buildVoucher(),
    ...overrides,
  };
}

function service(
  rewardsRepo: { [K in keyof RewardsRepository]?: unknown },
  creditsRepo = sameOrgMember,
  redemption: { [K in keyof RedemptionService]?: unknown } = {},
) {
  return new RewardsService(stub<RewardsRepository>(rewardsRepo), stub<RedemptionService>(redemption), creditsRepo);
}

describe('RewardsService.createVoucher', () => {
  it('creates a voucher with defaults and parsed dates, and maps it to a DTO', async () => {
    const createVoucher = vi.fn(async () =>
      buildVoucher({ startsAt: new Date('2026-11-01T00:00:00Z'), expiresAt: new Date('2026-12-01T00:00:00Z') }),
    );

    const dto = await service({ findVoucherByCode: async () => undefined, createVoucher }).createVoucher('org-1', {
      code: 'DISCOUNT10',
      title: '10% Off',
      discountType: 'PERCENTAGE',
      startsAt: '2026-11-01T00:00:00Z',
      expiresAt: '2026-12-01T00:00:00Z',
    });

    expect(createVoucher).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        pointsCost: 0,
        startsAt: new Date('2026-11-01T00:00:00Z'),
        expiresAt: new Date('2026-12-01T00:00:00Z'),
      }),
    );
    expect(dto).toMatchObject({
      id: 'v-1',
      pointsCost: 50,
      startsAt: '2026-11-01T00:00:00.000Z',
      expiresAt: '2026-12-01T00:00:00.000Z',
      createdAt: '2026-10-01T00:00:00.000Z',
    });
  });

  it('leaves optional dates undefined and passes an explicit points cost through', async () => {
    const createVoucher = vi.fn(async () => buildVoucher());

    const dto = await service({ findVoucherByCode: async () => undefined, createVoucher }).createVoucher('org-1', {
      code: 'X',
      title: 'X',
      discountType: 'FIXED_AMOUNT',
      pointsCost: 25,
    });

    expect(createVoucher).toHaveBeenCalledWith(
      expect.objectContaining({ pointsCost: 25, startsAt: undefined, expiresAt: undefined }),
    );
    expect(dto.startsAt).toBeNull();
    expect(dto.expiresAt).toBeNull();
  });

  it('rejects a duplicate code within the organization', async () => {
    const create = service({ findVoucherByCode: async () => buildVoucher() }).createVoucher('org-1', {
      code: 'DISCOUNT10',
      title: 't',
      discountType: 'PERCENTAGE',
    });

    await expect(create).rejects.toThrow(/already exists for this organization/);
  });
});

describe('RewardsService.listVouchers / getVoucher', () => {
  it('lists the organization’s vouchers as DTOs', async () => {
    const list = await service({
      listVouchersByOrganization: async () => [buildVoucher(), buildVoucher({ id: 'v-2' })],
    }).listVouchers('org-1');
    expect(list.map((v) => v.id)).toEqual(['v-1', 'v-2']);
  });

  it('a voucher belonging to another organization is treated as not found', async () => {
    const rewards = service({ findVoucherById: async (id: string) => (id === 'v-1' ? buildVoucher() : undefined) });

    expect((await rewards.getVoucher('org-1', 'v-1')).id).toBe('v-1');
    await expect(rewards.getVoucher('org-2', 'v-1')).rejects.toThrow(/not found/);
    await expect(rewards.getVoucher('org-1', 'v-missing')).rejects.toThrow(/not found/);
  });
});

describe('RewardsService.claimVoucher', () => {
  it('claims a paid voucher, deducting its points cost through RedemptionService', async () => {
    const executeRedeem = vi.fn(
      async (_orgId: string, req: { pointsAmount: number; organizationEndUserId: string; idempotencyKey: string }) => ({
        transactionId: 'tx-redeem-v-1',
        organizationEndUserId: req.organizationEndUserId,
        pointsRedeemed: req.pointsAmount,
        newBalance: 50,
        status: 'CONFIRMED',
        idempotencyKey: req.idempotencyKey,
      }),
    );
    const claimVoucherInstance = vi.fn(
      async (params: { serialCode: string; voucherId: string; organizationEndUserId: string }) => ({
        ownership: ownership({ serialCode: params.serialCode }),
        voucher: buildVoucher(),
      }),
    );

    const result = await service({ findVoucherById: async () => buildVoucher(), claimVoucherInstance }, sameOrgMember, {
      executeRedeem,
    }).claimVoucher('org-1', 'v-1', { organizationEndUserId: 'user-1', idempotencyKey: 'claim-key' });

    expect(executeRedeem).toHaveBeenCalledWith('org-1', {
      organizationEndUserId: 'user-1',
      pointsAmount: 50,
      idempotencyKey: 'claim-key',
      receiptReference: 'Claim Voucher: DISCOUNT10',
      metadata: { voucherId: 'v-1', voucherCode: 'DISCOUNT10' },
    });
    expect(claimVoucherInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        voucherId: 'v-1',
        organizationEndUserId: 'user-1',
        loyaltyTransactionId: 'tx-redeem-v-1',
      }),
    );
    expect(result.serialCode).toMatch(/^DISCOUNT10-[0-9A-F]{8}$/);
    expect(result).toMatchObject({
      voucherOwnershipId: 'own-1',
      voucherId: 'v-1',
      pointsDeducted: 50,
      claimedAt: '2026-10-02T00:00:00.000Z',
      expiresAt: null,
    });
  });

  it('generates an idempotency key for the redeem when the caller sends none', async () => {
    const executeRedeem = vi.fn(async () => ({ transactionId: 'tx-1' }));

    await service(
      {
        findVoucherById: async () => buildVoucher(),
        claimVoucherInstance: async () => ({
          ownership: ownership({ expiresAt: new Date('2027-01-01T00:00:00Z') }),
          voucher: buildVoucher(),
        }),
      },
      sameOrgMember,
      { executeRedeem },
    ).claimVoucher('org-1', 'v-1', { organizationEndUserId: 'user-1' });

    expect(executeRedeem).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^claim-v-1-user-1-\d+$/) }),
    );
  });

  it('claims a free voucher without any redeem call', async () => {
    const claimVoucherInstance = vi.fn(async () => ({
      ownership: ownership({ expiresAt: new Date('2027-01-01T00:00:00Z') }),
      voucher: buildVoucher({ pointsCost: 0 }),
    }));

    const result = await service(
      { findVoucherById: async () => buildVoucher({ pointsCost: 0 }), claimVoucherInstance },
      sameOrgMember,
      { executeRedeem: () => expect.fail('a free voucher costs nothing') },
    ).claimVoucher('org-1', 'v-1', { organizationEndUserId: 'user-1' });

    expect(claimVoucherInstance).toHaveBeenCalledWith(expect.objectContaining({ loyaltyTransactionId: undefined }));
    expect(result.pointsDeducted).toBe(0);
    expect(result.expiresAt).toBe('2027-01-01T00:00:00.000Z');
  });

  it('a second claim of the same voucher by the same member is rejected', async () => {
    const claim = service({
      findVoucherById: async () => buildVoucher({ code: 'FREESHIP', pointsCost: 0, claimedCount: 1 }),
      // Mirrors what voucher_ownership_voucher_member_idx enforces at the DB level too.
      claimVoucherInstance: async () => {
        throw new Error('Voucher has already been claimed by this member');
      },
    }).claimVoucher('org-1', 'v-1', { organizationEndUserId: 'user-1' });

    await expect(claim).rejects.toMatchObject({
      name: 'BadRequestException',
      message: expect.stringMatching(/already been claimed/),
    });
  });

  it('a non-Error claim failure becomes a generic 400', async () => {
    const claim = service({
      findVoucherById: async () => buildVoucher({ pointsCost: 0 }),
      claimVoucherInstance: async () => {
        throw undefined;
      },
    }).claimVoucher('org-1', 'v-1', { organizationEndUserId: 'user-1' });

    await expect(claim).rejects.toThrow('Failed to claim voucher');
  });

  it('rejects a voucher of another organization (or a missing one)', async () => {
    await expect(
      service({ findVoucherById: async () => buildVoucher({ organizationId: 'org-2' }) }).claimVoucher('org-1', 'v-1', {
        organizationEndUserId: 'user-1',
      }),
    ).rejects.toThrow(/Voucher with id v-1 not found/);
    await expect(
      service({ findVoucherById: async () => undefined }).claimVoucher('org-1', 'v-1', {
        organizationEndUserId: 'user-1',
      }),
    ).rejects.toThrow(/not found/);
  });

  it('claiming a free voucher (no redeem call) still rejects a cross-tenant member', async () => {
    const claim = service(
      {
        findVoucherById: async () => buildVoucher({ id: 'v-free', code: 'FREEGIFT', pointsCost: 0, totalSupply: null }),
        claimVoucherInstance: () => expect.fail('membership check must happen first'),
      },
      crossTenantMember,
    ).claimVoucher('org-1', 'v-free', { organizationEndUserId: 'user-org2' });

    await expect(claim).rejects.toThrow(/was not found for this organization/);
  });

  it('rejects an inactive voucher', async () => {
    const claim = service({ findVoucherById: async () => buildVoucher({ status: 'PAUSED' }) }).claimVoucher(
      'org-1',
      'v-1',
      {
        organizationEndUserId: 'user-1',
      },
    );

    await expect(claim).rejects.toThrow(/not active \(current status: PAUSED\)/);
  });

  it('rejects an expired voucher', async () => {
    const claim = service({
      findVoucherById: async () => buildVoucher({ expiresAt: new Date(Date.now() - 1000) }),
    }).claimVoucher('org-1', 'v-1', { organizationEndUserId: 'user-1' });

    await expect(claim).rejects.toThrow(/Voucher has expired/);
  });
});

describe('RewardsService.redeemVoucher', () => {
  it('marks an AVAILABLE voucher instance redeemed', async () => {
    const markVoucherRedeemed = vi.fn(async () => ({
      ...ownership(),
      status: 'REDEEMED',
      redeemedAt: new Date('2026-10-03T00:00:00Z'),
    }));

    const result = await service({ findOwnershipBySerial: async () => ownership(), markVoucherRedeemed }).redeemVoucher(
      'org-1',
      {
        serialCode: 'DISCOUNT10-ABCD1234',
      },
    );

    expect(markVoucherRedeemed).toHaveBeenCalledWith('own-1', expect.objectContaining({ organizationId: 'org-1' }));
    expect(result).toEqual({
      voucherOwnershipId: 'own-1',
      voucherId: 'v-1',
      serialCode: 'DISCOUNT10-ABCD1234',
      status: 'REDEEMED',
      redeemedAt: '2026-10-03T00:00:00.000Z',
      voucherTitle: '10% Off',
      discountType: 'PERCENTAGE',
      discountValue: '10.00',
    });
  });

  it('falls back to now when the update returns no redeemedAt', async () => {
    const result = await service({
      findOwnershipBySerial: async () => ownership(),
      markVoucherRedeemed: async () => ({ ...ownership(), status: 'REDEEMED', redeemedAt: null }),
    }).redeemVoucher('org-1', { serialCode: 's' });

    expect(Number.isNaN(Date.parse(result.redeemedAt))).toBe(false);
  });

  it('rejects an unknown serial or one from another organization', async () => {
    await expect(
      service({ findOwnershipBySerial: async () => undefined }).redeemVoucher('org-1', { serialCode: 's' }),
    ).rejects.toThrow(/serial code s not found/);
    await expect(
      service({
        findOwnershipBySerial: async () => ownership({ voucher: buildVoucher({ organizationId: 'org-2' }) }),
      }).redeemVoucher('org-1', { serialCode: 's' }),
    ).rejects.toThrow(/not found/);
  });

  it('queues voucher.redeemed with the redeem itself: the response plus the member (OCT-244)', async () => {
    const redeemed = { ...ownership(), status: 'REDEEMED', redeemedAt: new Date('2026-10-03T00:00:00Z') };
    let webhook: { organizationId: string; payload: (row: unknown) => unknown } | undefined;
    const markVoucherRedeemed = vi.fn(async (_id: string, w: typeof webhook) => {
      webhook = w;
      return redeemed;
    });

    await service({ findOwnershipBySerial: async () => ownership(), markVoucherRedeemed }).redeemVoucher('org-1', {
      serialCode: 'DISCOUNT10-ABCD1234',
    });

    expect(webhook?.organizationId).toBe('org-1');
    expect(webhook?.payload(redeemed)).toEqual({
      voucherOwnershipId: 'own-1',
      voucherId: 'v-1',
      organizationEndUserId: 'user-1',
      serialCode: 'DISCOUNT10-ABCD1234',
      status: 'REDEEMED',
      redeemedAt: '2026-10-03T00:00:00.000Z',
      voucherTitle: '10% Off',
      discountType: 'PERCENTAGE',
      discountValue: '10.00',
    });
  });

  it('a concurrent redeem that loses the race is a 409 (nothing was queued for it)', async () => {
    await expect(
      service({
        findOwnershipBySerial: async () => ownership(),
        markVoucherRedeemed: async () => undefined,
      }).redeemVoucher('org-1', { serialCode: 's' }),
    ).rejects.toMatchObject({ name: 'ConflictException' });
  });

  it('rejects an instance that is no longer AVAILABLE', async () => {
    await expect(
      service({ findOwnershipBySerial: async () => ownership({ status: 'REDEEMED' }) }).redeemVoucher('org-1', {
        serialCode: 's',
      }),
    ).rejects.toThrow(/status is currently REDEEMED/);
  });

  it('rejects an expired instance', async () => {
    await expect(
      service({
        findOwnershipBySerial: async () => ownership({ expiresAt: new Date(Date.now() - 1000) }),
      }).redeemVoucher('org-1', {
        serialCode: 's',
      }),
    ).rejects.toThrow(/expired/);
  });
});

describe('RewardsService.listMemberVouchers', () => {
  it('lists only this organization’s vouchers for the member', async () => {
    const list = await service({
      listOwnershipsByMember: async () => [
        ownership({ redeemedAt: new Date('2026-10-05T00:00:00Z'), expiresAt: new Date('2027-01-01T00:00:00Z') }),
        ownership({ id: 'own-foreign', voucher: buildVoucher({ organizationId: 'org-2' }) }),
      ],
    }).listMemberVouchers('org-1', 'user-1');

    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: 'own-1',
      redeemedAt: '2026-10-05T00:00:00.000Z',
      expiresAt: '2027-01-01T00:00:00.000Z',
      voucher: { id: 'v-1' },
    });
  });

  it('maps missing optional dates to null', async () => {
    const [entry] = await service({ listOwnershipsByMember: async () => [ownership()] }).listMemberVouchers(
      'org-1',
      'user-1',
    );
    expect(entry.redeemedAt).toBeNull();
    expect(entry.expiresAt).toBeNull();
  });

  it('rejects a cross-tenant member instead of silently returning an empty list', async () => {
    const list = service(
      { listOwnershipsByMember: () => expect.fail('membership check must happen first') },
      stub<CreditsRepository>({ findMemberOrganizationId: async () => 'org-2' }),
    ).listMemberVouchers('org-1', 'user-org2');

    await expect(list).rejects.toThrow(/was not found for this organization/);
  });
});
