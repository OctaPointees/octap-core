import { describe, expect, it, vi } from 'vitest';
import { RewardsService } from '#domain/rewards/rewards.service.js';
import { RewardsRuleError, type RewardsRepository } from '#infra/db/repositories/rewards.repository.js';
import type { PosRedemptionService } from '#domain/credits/pos-redemption.service.js';
import { OperationPayloadConflictError } from '#infra/db/repositories/operations.repository.js';
import type { CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import { stub } from '../../../helpers/stub.js';
import { PROGRAMS_REPO, buildVoucher, programsRepoFor } from '../../../helpers/fixtures.js';

const sameOrgMember = stub<CreditsRepository>({
  findMemberOrganizationId: async () => 'org-1',
  findOperationForClaim: async () => undefined,
  findBeneficiaryAddress: async () => '0xmember',
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

function service(rewardsRepo: { [K in keyof RewardsRepository]?: unknown }, creditsRepo = sameOrgMember) {
  return new RewardsService(
    stub<RewardsRepository>({ findVoucherById: async () => buildVoucher({ pointsCost: 0 }), ...rewardsRepo }),
    creditsRepo,
    stub<PosRedemptionService>({}),
    PROGRAMS_REPO,
  );
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
    expect(claimVoucher).toHaveBeenCalledWith('org-1', 'v-1', memberId, 'claim-key', {});
  });
  describe('a paid claim', () => {
    const reserved = {
      voucherOwnershipId: 'ownership-1',
      voucherId: 'v-1',
      organizationEndUserId: memberId,
      status: 'RESERVED',
      pointsCost: 25,
      pointsDeducted: 0,
      transactionId: 'tx-1',
      serialCode: 'CODE',
      claimedAt: '2026-10-29T00:00:00Z',
    };
    const hold = { transaction: { id: 'tx-1' }, accountId: '0xaccount', submittedDigest: null };

    function paidClaim({
      claim = reserved as Record<string, unknown>,
      previousOperation = undefined as unknown,
      beneficiary = '0xmember' as string | null,
      programs = PROGRAMS_REPO,
      sponsored = { status: 'PENDING', digest: 'digest', transactionBytes: 'bytes' } as Record<string, unknown>,
    } = {}) {
      const claimVoucher = vi.fn(async () => claim);
      const sponsorReservation = vi.fn(async () => sponsored);
      const findVoucherClaimHold = vi.fn(async () => hold);
      const getClaim = vi.fn(async () => ({ ...reserved, status: 'CANCELLED' }));
      const rewards = new RewardsService(
        stub<RewardsRepository>({
          findVoucherById: async () => buildVoucher({ pointsCost: 25 }),
          claimVoucher,
          getClaim,
        }),
        stub<CreditsRepository>({
          findBeneficiaryAddress: async () => beneficiary,
          findOperationForClaim: async () => previousOperation,
          findVoucherClaimHold,
        }),
        stub<PosRedemptionService>({ sponsorReservation }),
        programs,
      );
      const run = (idempotencyKey: string | null = 'claim-key') =>
        rewards.claimVoucher('org-1', 'v-1', {
          organizationEndUserId: memberId,
          idempotencyKey: idempotencyKey as string,
        });
      return { run, claimVoucher, sponsorReservation, findVoucherClaimHold, getClaim };
    }

    it('sponsors the reservation it just made, returning signable bytes without debiting points', async () => {
      const { run, sponsorReservation, findVoucherClaimHold } = paidClaim();

      await expect(run()).resolves.toMatchObject({
        status: 'RESERVED',
        pointsDeducted: 0,
        digest: 'digest',
        transactionBytes: 'bytes',
      });
      expect(findVoucherClaimHold).toHaveBeenCalledWith('org-1', 'claim-key');
      expect(sponsorReservation).toHaveBeenCalledWith(
        'org-1',
        { organizationEndUserId: memberId, pointsAmount: 25, idempotencyKey: 'claim-key' },
        { ...hold, voucherTermsId: '0xterms' },
      );
    });

    it('requires an explicit idempotency key', async () => {
      const { run, claimVoucher } = paidClaim();
      await expect(run(null)).rejects.toThrow(/idempotencyKey/);
      expect(claimVoucher).not.toHaveBeenCalled();
    });

    it('refuses an organization with no provisioned program before reserving anything', async () => {
      const { run, claimVoucher } = paidClaim({ programs: programsRepoFor({}) });
      await expect(run()).rejects.toThrow(/no on-chain program provisioned/);
      expect(claimVoucher).not.toHaveBeenCalled();
    });

    it('refuses a member with no linked Sui address before reserving anything', async () => {
      const { run, claimVoucher } = paidClaim({ beneficiary: null });
      await expect(run()).rejects.toThrow(/no linked Sui address/);
      expect(claimVoucher).not.toHaveBeenCalled();
    });

    it('a retry under an accepted key skips the prechecks and resumes signing', async () => {
      const { run, claimVoucher, sponsorReservation } = paidClaim({
        previousOperation: { suiTxDigest: null },
        beneficiary: null,
      });
      await expect(run()).resolves.toMatchObject({ digest: 'digest' });
      expect(claimVoucher).toHaveBeenCalledWith('org-1', 'v-1', memberId, 'claim-key', {});
      expect(sponsorReservation).toHaveBeenCalledOnce();
    });

    it('a retry still refuses to sponsor once the program is gone', async () => {
      const { run, sponsorReservation } = paidClaim({
        previousOperation: { suiTxDigest: null },
        programs: programsRepoFor({}),
      });
      await expect(run()).rejects.toThrow(/no on-chain program provisioned/);
      expect(sponsorReservation).not.toHaveBeenCalled();
    });

    it('a claim the chain already settled is reported as is, with nothing to sign', async () => {
      const { run, sponsorReservation } = paidClaim({
        previousOperation: { suiTxDigest: 'D' },
        claim: { ...reserved, status: 'AVAILABLE', pointsDeducted: 25 },
      });
      await expect(run()).resolves.toMatchObject({ status: 'AVAILABLE', pointsDeducted: 25 });
      expect(sponsorReservation).not.toHaveBeenCalled();
    });

    it('re-reads the claim when the hold settled between reserving and sponsoring', async () => {
      const { run, getClaim } = paidClaim({ sponsored: { status: 'FAILED', digest: null, transactionBytes: null } });
      await expect(run()).resolves.toMatchObject({ status: 'CANCELLED' });
      expect(getClaim).toHaveBeenCalledWith('org-1', 'ownership-1');
    });
  });

  it.each([
    [new RewardsRuleError('NOT_FOUND', 'Voucher not found'), 'NotFoundException'],
    [new RewardsRuleError('INVALID', 'Insufficient points'), 'BadRequestException'],
    [new RewardsRuleError('CONFLICT', 'Claim has no saved result'), 'ConflictException'],
    [new OperationPayloadConflictError('claim-key'), 'ConflictException'],
    [Object.assign(new Error('duplicate key'), { code: '23505' }), 'ConflictException'],
  ])('maps the repository failure %s to %s', async (failure, name) => {
    const claimVoucher = vi.fn(async () => {
      throw failure;
    });
    await expect(
      service({ claimVoucher }).claimVoucher('org-1', 'v-1', { organizationEndUserId: memberId, idempotencyKey: 'k' }),
    ).rejects.toMatchObject({ name });
  });

  describe('grantVoucher', () => {
    const request = { organizationEndUserId: memberId, idempotencyKey: 'grant-1' };

    it('reserves a grant, spending nothing, with no bytes to sign', async () => {
      const claimVoucher = vi.fn(async () => ({ status: 'RESERVED', transactionId: null }));
      await expect(service({ claimVoucher }).grantVoucher('org-1', 'v-1', request)).resolves.toMatchObject({
        status: 'RESERVED',
      });
      expect(claimVoucher).toHaveBeenCalledWith('org-1', 'v-1', memberId, 'grant-1', { grant: true });
    });

    it('validates the member and key, and needs an address on-chain', async () => {
      const claimVoucher = vi.fn();
      const rewards = service({ claimVoucher });
      await expect(rewards.grantVoucher('org-1', 'v-1', { ...request, organizationEndUserId: 'bad' })).rejects.toThrow(
        /UUID/,
      );
      await expect(rewards.grantVoucher('org-1', 'v-1', { ...request, idempotencyKey: '' })).rejects.toThrow(
        /idempotencyKey/,
      );
      const noAddress = stub<CreditsRepository>({
        findOperationForClaim: async () => undefined,
        findBeneficiaryAddress: async () => null,
      });
      await expect(service({ claimVoucher }, noAddress).grantVoucher('org-1', 'v-1', request)).rejects.toThrow(
        /no linked Sui address/,
      );
      expect(claimVoucher).not.toHaveBeenCalled();
    });

    it('a retry skips the prechecks, and a voucher from another organization is not found', async () => {
      const claimVoucher = vi.fn(async () => ({ status: 'RESERVED', transactionId: null }));
      const retrying = stub<CreditsRepository>({
        findOperationForClaim: async () => ({ id: 'op' }),
        findBeneficiaryAddress: async () => null,
      });
      await service({ claimVoucher }, retrying).grantVoucher('org-1', 'v-1', request);
      expect(claimVoucher).toHaveBeenCalledOnce();
      await expect(
        service({ findVoucherById: async () => buildVoucher({ organizationId: 'org-2' }) }).grantVoucher(
          'org-1',
          'v-1',
          request,
        ),
      ).rejects.toThrow(/not found/);
    });
  });

  it('rejects malformed members and claim keys before reaching the database', async () => {
    const claimVoucher = vi.fn();
    const rewards = service({ claimVoucher });
    await expect(
      rewards.claimVoucher('org-1', 'v-1', { organizationEndUserId: 'bad', idempotencyKey: 'k' }),
    ).rejects.toThrow(/UUID/);
    await expect(
      rewards.claimVoucher('org-1', 'v-1', { organizationEndUserId: memberId, idempotencyKey: '' }),
    ).rejects.toThrow(/idempotencyKey/);
    expect(claimVoucher).not.toHaveBeenCalled();
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
