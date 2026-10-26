import { describe, expect, it, vi } from 'vitest';
import { RewardsService } from '#domain/rewards/rewards.service.js';
import type { RewardsRepository } from '#infra/db/repositories/rewards.repository.js';
import type { CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import { stub } from '../../../helpers/stub.js';
import { buildVoucher } from '../../../helpers/fixtures.js';

const sameOrgMember = stub<CreditsRepository>({ findMemberOrganizationId: async () => 'org-1' });

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

function service(rewardsRepo: { [K in keyof RewardsRepository]?: unknown }, creditsRepo = sameOrgMember) {
  return new RewardsService(stub<RewardsRepository>(rewardsRepo), creditsRepo);
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
      discountValue: '10.00',
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
      discountValue: '10.00',
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
      discountValue: '10.00',
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

describe('RewardsService claims and redemption', () => {
  const memberId = '11111111-1111-4111-8111-111111111111';
  it('delegates the entire claim to one atomic repository operation', async () => {
    const result = { voucherOwnershipId: 'own-1', serialCode: 'CODE-123', pointsDeducted: 25 };
    const claimVoucher = vi.fn(async () => result);
    expect(
      await service({ claimVoucher }).claimVoucher('org-1', 'v-1', {
        organizationEndUserId: memberId,
        idempotencyKey: 'claim-key',
      }),
    ).toEqual(result);
    expect(claimVoucher).toHaveBeenCalledWith('org-1', 'v-1', memberId, 'claim-key');
    await service({ claimVoucher }).claimVoucher('org-1', 'v-1', { organizationEndUserId: memberId });
    expect(claimVoucher).toHaveBeenLastCalledWith('org-1', 'v-1', memberId, `claim-v-1-${memberId}`);
  });
  it('rejects malformed members and claim keys before reaching the database', async () => {
    const claimVoucher = vi.fn();
    const rewards = service({ claimVoucher });
    await expect(rewards.claimVoucher('org-1', 'v-1', { organizationEndUserId: 'bad' })).rejects.toThrow(/UUID/);
    await expect(
      rewards.claimVoucher('org-1', 'v-1', { organizationEndUserId: memberId, idempotencyKey: '' }),
    ).rejects.toThrow(/idempotencyKey/);
    expect(claimVoucher).not.toHaveBeenCalled();
  });
  it('maps the atomically redeemed ownership and frozen reward benefit', async () => {
    const redeemVoucher = vi.fn(async () => ({
      ownership: ownership({ status: 'REDEEMED', redeemedAt: new Date('2026-10-03T00:00:00Z') }),
      voucher: buildVoucher(),
    }));
    const result = await service({ redeemVoucher }).redeemVoucher('org-1', { serialCode: 'CODE-123' });
    expect(result).toMatchObject({
      status: 'REDEEMED',
      redeemedAt: '2026-10-03T00:00:00.000Z',
      voucherTitle: '10% Off',
    });
    expect(redeemVoucher).toHaveBeenCalledWith('org-1', 'CODE-123');
    await expect(service({ redeemVoucher }).redeemVoucher('org-1', { serialCode: '' })).rejects.toThrow(/serialCode/);
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
