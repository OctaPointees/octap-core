import { describe, expect, it, vi } from 'vitest';
import { PosRedemptionService } from '../../../../src/domain/credits/pos-redemption.service.js';
import { OperationPayloadConflictError } from '../../../../src/infra/db/repositories/operations.repository.js';
import type { CreditsRepository } from '../../../../src/infra/db/repositories/credits.repository.js';
import type { SponsoredTransactionService } from '../../../../src/domain/identity/sponsored-transaction.service.js';
import type { SuiTransactionBuilderClient } from '../../../../src/infra/clients/sui/sui-transaction-builder.client.js';
import type { WebhookDeliveryService } from '../../../../src/domain/webhooks/webhook-delivery.service.js';
import type { ProgramsRepository } from '../../../../src/infra/db/repositories/programs.repository.js';
import { stub } from '../../../helpers/stub.js';
import { fakeRedis } from '../../../helpers/redis.js';
import { PROGRAMS_REPO, buildLoyaltyTransaction, programsRepoFor } from '../../../helpers/fixtures.js';

const reserveRequest = { organizationEndUserId: 'user-1', pointsAmount: 50, idempotencyKey: 'idem-1' };
const cachedReserve = {
  organizationId: 'org-1',
  organizationEndUserId: 'user-1',
  loyaltyTransactionId: 'tx-1',
  pointsAmount: 50,
  transactionBytes: 'bytes-1',
};

function pendingHold(status: 'PENDING' | 'CONFIRMED' | 'FAILED' = 'PENDING', isNew = true, accountId: string | null = 'account-1') {
  return async () => ({
    transaction: buildLoyaltyTransaction({ id: 'tx-1', transactionType: 'REDEEM', status, idempotencyKey: 'idem-1' }),
    accountId,
    isNew,
  });
}

function service({
  redis = fakeRedis(),
  creditsRepo = {},
  sponsoredTx = {},
  suiBuilder = {},
  webhooks = {},
  programsRepo = PROGRAMS_REPO,
}: {
  redis?: ReturnType<typeof fakeRedis>;
  creditsRepo?: { [K in keyof CreditsRepository]?: unknown };
  sponsoredTx?: { [K in keyof SponsoredTransactionService]?: unknown };
  suiBuilder?: { [K in keyof SuiTransactionBuilderClient]?: unknown };
  webhooks?: { [K in keyof WebhookDeliveryService]?: unknown };
  programsRepo?: ProgramsRepository;
} = {}) {
  return new PosRedemptionService(
    redis,
    stub<CreditsRepository>(creditsRepo),
    stub<SponsoredTransactionService>(sponsoredTx),
    stub<SuiTransactionBuilderClient>(suiBuilder),
    stub<WebhookDeliveryService>(webhooks),
    programsRepo,
  );
}

async function redisWithCachedReserve() {
  const redis = fakeRedis();
  await redis.set('pos-redeem:reserve:digest-1', JSON.stringify(cachedReserve));
  return redis;
}

describe('PosRedemptionService.reserve', () => {
  it('builds, sponsors, and caches a new hold for 10 minutes', async () => {
    const redis = fakeRedis();
    const previewSponsoredRedeem = vi.fn(async () => ({ transactionBytes: 'bytes-1', digest: 'digest-1' }));
    const reservePosRedemption = vi.fn(pendingHold());

    const result = await service({
      redis,
      creditsRepo: {
        findMemberOrganizationId: async () => 'org-1',
        reservePosRedemption,
        findBeneficiaryAddress: async () => '0xbeneficiary',
      },
      sponsoredTx: { previewSponsoredRedeem },
    }).reserve('org-1', reserveRequest);

    expect(result).toEqual({
      transactionId: 'tx-1',
      digest: 'digest-1',
      transactionBytes: 'bytes-1',
      status: 'PENDING',
      idempotencyKey: 'idem-1',
    });
    expect(reservePosRedemption).toHaveBeenCalledWith({ organizationId: 'org-1', ...reserveRequest });
    expect(previewSponsoredRedeem).toHaveBeenCalledWith({
      beneficiaryAddress: '0xbeneficiary',
      accountId: 'account-1',
      cost: 50n,
      reference: new TextEncoder().encode('tx-1'),
    });
    expect(JSON.parse((await redis.get('pos-redeem:reserve:digest-1'))!)).toEqual(cachedReserve);
    expect(await redis.get('pos-redeem:idem:org-1:idem-1')).toBe('digest-1');
    expect(redis.ttls.get('pos-redeem:reserve:digest-1')).toBe(600);
  });

  it('rejects a non-positive amount', async () => {
    await expect(service().reserve('org-1', { ...reserveRequest, pointsAmount: 0 })).rejects.toThrow(/greater than zero/);
  });

  it('rejects a member from another organization', async () => {
    await expect(
      service({ creditsRepo: { findMemberOrganizationId: async () => 'org-2' } }).reserve('org-1', reserveRequest),
    ).rejects.toThrow(/was not found for this organization/);
  });

  it('maps a payload conflict to a 409', async () => {
    const reserve = service({
      creditsRepo: {
        findMemberOrganizationId: async () => 'org-1',
        reservePosRedemption: async () => {
          throw new OperationPayloadConflictError('idem-1');
        },
      },
    }).reserve('org-1', reserveRequest);

    await expect(reserve).rejects.toMatchObject({ name: 'ConflictException', message: expect.stringMatching(/different payload/) });
  });

  it('maps any other reservation failure (insufficient points) to a 400', async () => {
    const reserve = service({
      creditsRepo: {
        findMemberOrganizationId: async () => 'org-1',
        reservePosRedemption: async () => {
          throw new Error('Insufficient points: required 50, available 10');
        },
      },
    }).reserve('org-1', reserveRequest);

    await expect(reserve).rejects.toMatchObject({ name: 'BadRequestException', message: expect.stringMatching(/Insufficient/) });
  });

  it('uses a generic message for a non-Error reservation failure', async () => {
    const reserve = service({
      creditsRepo: {
        findMemberOrganizationId: async () => 'org-1',
        reservePosRedemption: async () => {
          throw null;
        },
      },
    }).reserve('org-1', reserveRequest);

    await expect(reserve).rejects.toThrow('Failed to reserve redemption');
  });

  it('replays cached bytes instead of sponsoring twice', async () => {
    const redis = fakeRedis();
    await redis.set('pos-redeem:idem:org-1:idem-1', 'digest-cached');
    await redis.set('pos-redeem:reserve:digest-cached', JSON.stringify({ ...cachedReserve, transactionBytes: 'bytes-cached' }));

    const result = await service({
      redis,
      creditsRepo: { findMemberOrganizationId: async () => 'org-1', reservePosRedemption: pendingHold('PENDING', false) },
      sponsoredTx: { previewSponsoredRedeem: () => expect.fail('must not sponsor twice') },
    }).reserve('org-1', reserveRequest);

    expect(result.digest).toBe('digest-cached');
    expect(result.transactionBytes).toBe('bytes-cached');
  });

  it('re-sponsors when the idempotency pointer survived but the reservation entry lapsed', async () => {
    const redis = fakeRedis();
    await redis.set('pos-redeem:idem:org-1:idem-1', 'digest-gone');

    const result = await service({
      redis,
      creditsRepo: {
        findMemberOrganizationId: async () => 'org-1',
        reservePosRedemption: pendingHold('PENDING', false),
        findBeneficiaryAddress: async () => '0xbeneficiary',
      },
      sponsoredTx: { previewSponsoredRedeem: async () => ({ transactionBytes: 'bytes-fresh', digest: 'digest-fresh' }) },
    }).reserve('org-1', reserveRequest);

    expect(result.digest).toBe('digest-fresh');
  });

  it('re-sponsors when the cache lapsed entirely on a retry of an existing hold', async () => {
    const previewSponsoredRedeem = vi.fn(async () => ({ transactionBytes: 'bytes-fresh', digest: 'digest-fresh' }));

    const result = await service({
      creditsRepo: {
        findMemberOrganizationId: async () => 'org-1',
        reservePosRedemption: pendingHold('PENDING', false),
        findBeneficiaryAddress: async () => '0xbeneficiary',
      },
      sponsoredTx: { previewSponsoredRedeem },
    }).reserve('org-1', reserveRequest);

    expect(previewSponsoredRedeem).toHaveBeenCalledOnce();
    expect(result.digest).toBe('digest-fresh');
  });

  it.each(['CONFIRMED', 'FAILED'] as const)(
    'an already-settled (%s) idempotency key returns the final state without touching chain',
    async (status) => {
      const result = await service({
        creditsRepo: { findMemberOrganizationId: async () => 'org-1', reservePosRedemption: pendingHold(status, false) },
        sponsoredTx: { previewSponsoredRedeem: () => expect.fail('nothing left to sign') },
      }).reserve('org-1', reserveRequest);

      expect(result).toEqual({ transactionId: 'tx-1', digest: null, transactionBytes: null, status, idempotencyKey: 'idem-1' });
    },
  );

  it('rejects a hold for a member with no on-chain CreditAccount', async () => {
    const reserve = service({
      creditsRepo: { findMemberOrganizationId: async () => 'org-1', reservePosRedemption: pendingHold('PENDING', true, null) },
    }).reserve('org-1', reserveRequest);

    await expect(reserve).rejects.toThrow(/has no on-chain CreditAccount yet/);
  });

  it('rejects a hold for a member with no linked Sui address', async () => {
    const reserve = service({
      creditsRepo: {
        findMemberOrganizationId: async () => 'org-1',
        reservePosRedemption: pendingHold(),
        findBeneficiaryAddress: async () => null,
      },
    }).reserve('org-1', reserveRequest);

    await expect(reserve).rejects.toThrow(/has no linked Sui address yet/);
  });
});

describe('PosRedemptionService.finalize', () => {
  it('confirms on-chain success, clears the cache, and emits a webhook', async () => {
    const redis = await redisWithCachedReserve();
    const confirmPosRedemptionOnChain = vi.fn(async () => ({ id: 'btx-1' }));
    const emit = vi.fn(async () => {});

    const result = await service({
      redis,
      creditsRepo: {
        findBeneficiaryAddress: async () => '0xbeneficiary',
        confirmPosRedemptionOnChain,
        getOrCreateCreditOwnership: async () => ({ confirmedBalance: 150 }),
      },
      sponsoredTx: { executeSponsoredRedeem: async () => ({ digest: 'digest-1' }) },
      suiBuilder: { waitForTransaction: async () => ({ digest: 'digest-1', status: 'success', events: [] }) },
      webhooks: { emit },
    }).finalize({ digest: 'digest-1', signature: 'sig-1' });

    expect(result).toEqual({
      transactionId: 'tx-1',
      organizationEndUserId: 'user-1',
      pointsRedeemed: 50,
      newBalance: 150,
      status: 'CONFIRMED',
      blockchainDigest: 'digest-1',
    });
    expect(confirmPosRedemptionOnChain).toHaveBeenCalledWith({
      loyaltyTransactionId: 'tx-1',
      organizationEndUserId: 'user-1',
      pointsAmount: 50,
      digest: 'digest-1',
      sender: '0xbeneficiary',
    });
    expect(emit).toHaveBeenCalledWith('org-1', 'credits.redeemed', {
      transactionId: 'tx-1',
      organizationEndUserId: 'user-1',
      pointsAmount: 50,
      newBalance: 150,
      blockchainDigest: 'digest-1',
    });
    expect(await redis.get('pos-redeem:reserve:digest-1')).toBeNull();
  });

  it('rejects an unknown or expired digest', async () => {
    await expect(service().finalize({ digest: 'ghost-digest', signature: 'sig-1' })).rejects.toThrow(/expired/);
  });

  it('with no beneficiary address fails before executing anything', async () => {
    const finalize = service({
      redis: await redisWithCachedReserve(),
      creditsRepo: { findBeneficiaryAddress: async () => null },
      sponsoredTx: { executeSponsoredRedeem: () => expect.fail('must not execute') },
    }).finalize({ digest: 'digest-1', signature: 'sig-1' });

    await expect(finalize).rejects.toThrow(/No real Sui address/);
  });

  it('leaves the reservation intact when Enoki execute fails', async () => {
    const redis = await redisWithCachedReserve();
    const finalize = service({
      redis,
      creditsRepo: { findBeneficiaryAddress: async () => '0xbeneficiary' },
      sponsoredTx: {
        executeSponsoredRedeem: async () => {
          throw new Error('signature expired');
        },
      },
    }).finalize({ digest: 'digest-1', signature: 'bad-sig' });

    await expect(finalize).rejects.toMatchObject({ name: 'BadRequestException', message: 'signature expired' });
    expect(await redis.get('pos-redeem:reserve:digest-1')).not.toBeNull();
  });

  it('uses a generic message when Enoki throws a non-Error', async () => {
    const finalize = service({
      redis: await redisWithCachedReserve(),
      creditsRepo: { findBeneficiaryAddress: async () => '0xbeneficiary' },
      sponsoredTx: {
        executeSponsoredRedeem: async () => {
          throw 'nope';
        },
      },
    }).finalize({ digest: 'digest-1', signature: 'sig-1' });

    await expect(finalize).rejects.toThrow('Enoki execute failed');
  });

  it('releases the hold on a definitive on-chain failure', async () => {
    const redis = await redisWithCachedReserve();
    const failPosRedemptionOnChain = vi.fn(async () => {});

    const finalize = service({
      redis,
      creditsRepo: { findBeneficiaryAddress: async () => '0xbeneficiary', failPosRedemptionOnChain },
      sponsoredTx: { executeSponsoredRedeem: async () => ({ digest: 'digest-1' }) },
      suiBuilder: { waitForTransaction: async () => ({ status: 'failure', errorMessage: 'EInsufficientBalance' }) },
    }).finalize({ digest: 'digest-1', signature: 'sig-1' });

    await expect(finalize).rejects.toThrow(/EInsufficientBalance/);
    expect(failPosRedemptionOnChain).toHaveBeenCalledWith({
      loyaltyTransactionId: 'tx-1',
      organizationEndUserId: 'user-1',
      pointsAmount: 50,
    });
    expect(await redis.get('pos-redeem:reserve:digest-1')).toBeNull();
  });

  it('falls back to a generic message for an on-chain failure without one', async () => {
    const finalize = service({
      redis: await redisWithCachedReserve(),
      creditsRepo: { findBeneficiaryAddress: async () => '0xbeneficiary', failPosRedemptionOnChain: async () => {} },
      sponsoredTx: { executeSponsoredRedeem: async () => ({ digest: 'digest-1' }) },
      suiBuilder: { waitForTransaction: async () => ({ status: 'failure' }) },
    }).finalize({ digest: 'digest-1', signature: 'sig-1' });

    await expect(finalize).rejects.toThrow('Redeem failed on-chain');
  });

  it.each([
    ['wrapped by drizzle (cause.code)', Object.assign(new Error('Failed query'), { cause: { code: '23505' } })],
    ['raw postgres-js (code)', Object.assign(new Error('duplicate key'), { code: '23505' })],
  ])('a concurrent finalize of the same digest answers CONFIRMED, not a 500 — %s', async (_label, uniqueViolation) => {
    const result = await service({
      redis: await redisWithCachedReserve(),
      creditsRepo: {
        findBeneficiaryAddress: async () => '0xbeneficiary',
        confirmPosRedemptionOnChain: async () => {
          throw uniqueViolation;
        },
        getOrCreateCreditOwnership: async () => ({ confirmedBalance: 100 }),
      },
      sponsoredTx: { executeSponsoredRedeem: async () => ({ digest: 'digest-1' }) },
      suiBuilder: { waitForTransaction: async () => ({ status: 'success', digest: 'digest-1', events: [] }) },
      webhooks: { emit: () => expect.fail('the first finalize owns the webhook') },
    }).finalize({ digest: 'digest-1', signature: 'sig-1' });

    expect(result).toMatchObject({ status: 'CONFIRMED', blockchainDigest: 'digest-1', newBalance: 100 });
  });

  it('rethrows a confirm failure that is not a unique violation', async () => {
    const finalize = service({
      redis: await redisWithCachedReserve(),
      creditsRepo: {
        findBeneficiaryAddress: async () => '0xbeneficiary',
        confirmPosRedemptionOnChain: async () => {
          throw new Error('connection reset');
        },
      },
      sponsoredTx: { executeSponsoredRedeem: async () => ({ digest: 'digest-1' }) },
      suiBuilder: { waitForTransaction: async () => ({ status: 'success', digest: 'digest-1', events: [] }) },
    }).finalize({ digest: 'digest-1', signature: 'sig-1' });

    await expect(finalize).rejects.toThrow('connection reset');
  });
});

describe('PosRedemptionService per-organization programs (OCT-73)', () => {
  it('reserve rejects with 422 for an organization without a program, holding nothing', async () => {
    const reserve = service({
      creditsRepo: {
        findMemberOrganizationId: async () => 'org-1',
        reservePosRedemption: () => expect.fail('must not hold points'),
      },
      programsRepo: programsRepoFor({}),
    }).reserve('org-1', reserveRequest);

    await expect(reserve).rejects.toMatchObject({ status: 422 });
    await expect(reserve).rejects.toThrow(/org-1 has no on-chain program provisioned/);
  });
});
