import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { VoucherUseService } from '#domain/rewards/voucher-use.service.js';
import type { SponsoredTransactionService } from '#domain/identity/sponsored-transaction.service.js';
import type { SuiTransactionBuilderClient } from '#infra/clients/sui/sui-transaction-builder.client.js';
import type { CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import {
  OperationPayloadConflictError,
  type OperationsRepository,
} from '#infra/db/repositories/operations.repository.js';
import { RewardsRuleError, type RewardsRepository } from '#infra/db/repositories/rewards.repository.js';
import { stub } from '../../../helpers/stub.js';
import { buildVoucher } from '../../../helpers/fixtures.js';
import { fakeRedis } from '../../../helpers/redis.js';

const ownership = (overrides: Record<string, unknown> = {}) => ({
  id: 'own-1',
  voucherId: 'v-1',
  organizationEndUserId: 'member-1',
  serialCode: 'COFFEE-1',
  status: 'AVAILABLE',
  redeemedAt: null,
  ...overrides,
});

const prepared = (overrides: Record<string, unknown> = {}) => ({
  ownership: ownership(),
  voucher: buildVoucher(),
  operation: { id: 'op-1', status: 'PENDING', suiTxDigest: null },
  isNew: true,
  ...overrides,
});

function fixture({
  rewards = {},
  credits = {},
  operations = {},
  sponsored = {},
  builder = {},
}: {
  rewards?: { [K in keyof RewardsRepository]?: unknown };
  credits?: { [K in keyof CreditsRepository]?: unknown };
  operations?: { [K in keyof OperationsRepository]?: unknown };
  sponsored?: { [K in keyof SponsoredTransactionService]?: unknown };
  builder?: { [K in keyof SuiTransactionBuilderClient]?: unknown };
} = {}) {
  const redis = fakeRedis();
  const preview = vi.fn(async () => ({ digest: 'DIGEST', transactionBytes: 'BYTES' }));
  const service = new VoucherUseService(
    redis as unknown as Redis,
    stub<RewardsRepository>({ reserveVoucherUse: async () => prepared(), ...rewards }),
    stub<CreditsRepository>({
      findBeneficiaryAddress: async () => '0xmember',
      getCreditOwnershipByEndUserId: async () => ({ suiCreditAccountId: '0xaccount' }),
      ...credits,
    }),
    stub<OperationsRepository>({
      recordSubmitDigestForCommand: async () => 'op-1',
      settleFromChain: async () => true,
      ...operations,
    }),
    stub<SponsoredTransactionService>({
      previewSponsoredUseVoucher: preview,
      executeSponsoredRedeem: async () => ({ digest: 'DIGEST' }),
      ...sponsored,
    }),
    stub<SuiTransactionBuilderClient>({
      waitForTransaction: async () => ({ digest: 'DIGEST', status: 'success', events: [] }),
      ...builder,
    }),
  );
  return { service, redis, preview };
}

const request = { serialCode: 'COFFEE-1', idempotencyKey: 'use-1' };

describe('VoucherUseService.prepare', () => {
  it('returns bytes for the customer to sign and marks nothing used', async () => {
    const { service, preview } = fixture();
    const result = await service.prepare('org-1', request);
    expect(result).toMatchObject({
      voucherOwnershipId: 'own-1',
      status: 'AVAILABLE',
      digest: 'DIGEST',
      transactionBytes: 'BYTES',
      voucherTitle: '10% Off',
    });
    expect(preview).toHaveBeenCalledWith({
      beneficiaryAddress: '0xmember',
      accountId: '0xaccount',
      termsId: '0xterms',
      reference: new TextEncoder().encode('voucher-claim-own-1'),
    });
  });

  it('validates the serial and key before touching anything', async () => {
    const reserveVoucherUse = vi.fn();
    const { service } = fixture({ rewards: { reserveVoucherUse } });
    await expect(service.prepare('org-1', { ...request, serialCode: 'not valid!' })).rejects.toThrow(/serialCode/);
    await expect(service.prepare('org-1', { ...request, idempotencyKey: '' })).rejects.toThrow(/idempotencyKey/);
    expect(reserveVoucherUse).not.toHaveBeenCalled();
  });

  it.each([
    ['NOT_FOUND', 404],
    ['CONFLICT', 409],
    ['INVALID', 400],
  ] as const)('maps a %s rule to HTTP %i', async (kind, status) => {
    const { service } = fixture({
      rewards: {
        reserveVoucherUse: async () => {
          throw new RewardsRuleError(kind, 'nope');
        },
      },
    });
    await expect(service.prepare('org-1', request)).rejects.toMatchObject({ status });
  });

  it('maps a reused key to a conflict', async () => {
    const { service } = fixture({
      rewards: {
        reserveVoucherUse: async () => {
          throw new OperationPayloadConflictError('use-1');
        },
      },
    });
    await expect(service.prepare('org-1', request)).rejects.toMatchObject({ status: 409 });
  });

  it('a retry replays the cached bytes instead of sponsoring again', async () => {
    const { service, preview } = fixture();
    await service.prepare('org-1', request);
    const {
      service: retrying,
      redis,
      preview: retryPreview,
    } = fixture({
      rewards: { reserveVoucherUse: async () => prepared({ isNew: false }) },
    });
    await redis.set('voucher-use:idem:org-1:use-1', 'CACHED');
    await redis.set('voucher-use:reserve:CACHED', JSON.stringify({ transactionBytes: 'OLD' }));
    expect(await retrying.prepare('org-1', request)).toMatchObject({ digest: 'CACHED', transactionBytes: 'OLD' });
    expect(retryPreview).not.toHaveBeenCalled();
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it('a retry sponsors fresh bytes once the cache lapsed, unless a finalize is still being resolved', async () => {
    const { service, preview } = fixture({
      rewards: { reserveVoucherUse: async () => prepared({ isNew: false }) },
    });
    expect(await service.prepare('org-1', request)).toMatchObject({ digest: 'DIGEST' });
    expect(preview).toHaveBeenCalledTimes(1);

    const { service: pinned } = fixture({
      rewards: {
        reserveVoucherUse: async () =>
          prepared({ isNew: false, operation: { id: 'op-1', status: 'PENDING', suiTxDigest: 'SENT' } }),
      },
    });
    await expect(pinned.prepare('org-1', request)).rejects.toMatchObject({ status: 409 });
  });

  it('a settled use has nothing left to sign', async () => {
    const { service, preview } = fixture({
      rewards: {
        reserveVoucherUse: async () =>
          prepared({
            isNew: false,
            ownership: ownership({ status: 'REDEEMED' }),
            operation: { id: 'op-1', status: 'SUBMITTED', suiTxDigest: 'SENT' },
          }),
      },
    });
    expect(await service.prepare('org-1', request)).toMatchObject({
      status: 'REDEEMED',
      digest: null,
      transactionBytes: null,
    });
    expect(preview).not.toHaveBeenCalled();
  });

  it('a use that ended tells the merchant to start again', async () => {
    const { service, preview } = fixture({
      rewards: {
        reserveVoucherUse: async () =>
          prepared({ isNew: false, operation: { id: 'op-1', status: 'FAILED', suiTxDigest: null } }),
      },
    });
    await expect(service.prepare('org-1', request)).rejects.toMatchObject({ status: 409 });
    expect(preview).not.toHaveBeenCalled();
  });

  it.each([
    ['no address', { credits: { findBeneficiaryAddress: async () => null } }],
    ['no account', { credits: { getCreditOwnershipByEndUserId: async () => ({ suiCreditAccountId: null }) } }],
    [
      'no terms',
      { rewards: { reserveVoucherUse: async () => prepared({ voucher: buildVoucher({ suiTermsId: null }) }) } },
    ],
  ])('refuses a voucher with %s on-chain', async (_, overrides) => {
    const { service } = fixture(overrides);
    await expect(service.prepare('org-1', request)).rejects.toThrow(/no on-chain record/);
  });
});

describe('VoucherUseService.finalize', () => {
  const prepareThen = async (overrides: Parameters<typeof fixture>[0] = {}) => {
    const context = fixture(overrides);
    await context.service.prepare('org-1', request);
    return context;
  };
  const signed = { digest: 'DIGEST', signature: 'SIG' };

  it('marks it used from the chain verdict and settles the command', async () => {
    const redeemed = ownership({ status: 'REDEEMED', redeemedAt: new Date('2026-11-05T00:00:00Z') });
    const confirmVoucherUse = vi.fn(async () => ({
      ownership: redeemed,
      voucher: buildVoucher(),
      key: null,
      applied: true,
    }));
    const settleFromChain = vi.fn(async () => true);
    const { service, redis } = await prepareThen({
      rewards: { confirmVoucherUse },
      operations: { settleFromChain },
    });
    expect(await service.finalize(signed)).toMatchObject({
      voucherOwnershipId: 'own-1',
      status: 'REDEEMED',
      redeemedAt: '2026-11-05T00:00:00.000Z',
      blockchainDigest: 'DIGEST',
    });
    expect(confirmVoucherUse).toHaveBeenCalledWith({ voucherOwnershipId: 'own-1', digest: 'DIGEST' });
    expect(settleFromChain).toHaveBeenCalledWith('op-1', 'SUBMITTED');
    expect(await redis.get('voucher-use:reserve:DIGEST')).toBeNull();
  });

  it('refuses an unknown or expired digest', async () => {
    await expect(fixture().service.finalize(signed)).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a use that already settled without executing anything', async () => {
    const executeSponsoredRedeem = vi.fn();
    const { service } = await prepareThen({
      operations: { recordSubmitDigestForCommand: async () => null },
      sponsored: { executeSponsoredRedeem },
    });
    await expect(service.finalize(signed)).rejects.toMatchObject({ status: 409 });
    expect(executeSponsoredRedeem).not.toHaveBeenCalled();
  });

  it('a rejected signature releases nothing, so it can be retried with a fixed one', async () => {
    const failVoucherUse = vi.fn();
    const { service, redis } = await prepareThen({
      rewards: { failVoucherUse },
      sponsored: {
        executeSponsoredRedeem: async () => {
          throw new Error('bad signature');
        },
      },
    });
    await expect(service.finalize(signed)).rejects.toThrow(/bad signature/);
    expect(failVoucherUse).not.toHaveBeenCalled();
    expect(await redis.get('voucher-use:reserve:DIGEST')).not.toBeNull();
  });

  it('a failure verdict ends the use and leaves the voucher available', async () => {
    const failVoucherUse = vi.fn(async () => true);
    const settleFromChain = vi.fn(async () => true);
    const confirmVoucherUse = vi.fn();
    const { service } = await prepareThen({
      rewards: { failVoucherUse, confirmVoucherUse },
      operations: { settleFromChain },
      builder: {
        waitForTransaction: async () => ({ digest: 'DIGEST', status: 'failure', errorMessage: 'EVoucherNotAvailable' }),
      },
    });
    await expect(service.finalize(signed)).rejects.toThrow(/EVoucherNotAvailable/);
    expect(failVoucherUse).toHaveBeenCalledWith({ operationId: 'op-1', voucherOwnershipId: 'own-1' });
    expect(settleFromChain).toHaveBeenCalledWith('op-1', 'FAILED', 'EVoucherNotAvailable');
    expect(confirmVoucherUse).not.toHaveBeenCalled();
  });

  it('reports a use the chain recorded on a voucher that was already taken back', async () => {
    const { service } = await prepareThen({ rewards: { confirmVoucherUse: async () => null } });
    await expect(service.finalize(signed)).rejects.toMatchObject({ status: 409 });
  });
});
