import { evaluateVoucherRefund } from '#domain/rewards/refund-policy.js';
import { describe, expect, it, vi } from 'vitest';
import { ReversalService } from '#domain/credits/reversal.service.js';
import { VoucherClaimNotReversibleError, type CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import { stub } from '../../../helpers/stub.js';
import { buildLoyaltyTransaction } from '../../../helpers/fixtures.js';

const confirmedEarn = buildLoyaltyTransaction;
const reverse = (overrides: Partial<{ transactionId: string; idempotencyKey: string; reason: string }> = {}) => ({
  transactionId: 'tx-earn-1',
  idempotencyKey: 'reverse-1',
  reason: 'Chargeback from payment provider',
  ...overrides,
});

describe('ReversalService', () => {
  it('reverses a CONFIRMED earn and can drive the balance negative (clawback debt)', async () => {
    const recordReversalTransaction = vi.fn(
      async (params: { idempotencyKey: string; original: { pointsAmount: number } }) => ({
        reversal: buildLoyaltyTransaction({
          id: 'tx-reversal-1',
          transactionType: 'REVERSAL',
          idempotencyKey: params.idempotencyKey,
          pointsAmount: params.original.pointsAmount,
        }),
        reversedOriginal: confirmedEarn({ status: 'REVERSED' }),
        newBalance: -20,
      }),
    );
    const repo = stub<CreditsRepository>({
      findTransactionByIdempotency: async () => undefined,
      findTransactionByIdForOrganization: async (orgId: string, id: string) =>
        orgId === 'org-1' && id === 'tx-earn-1' ? confirmedEarn() : undefined,
      recordReversalTransaction,
    });

    const result = await new ReversalService(repo).reverseTransaction('org-1', reverse());

    expect(result).toEqual({
      reversalTransactionId: 'tx-reversal-1',
      reversedTransactionId: 'tx-earn-1',
      organizationEndUserId: 'user-1',
      pointsAmount: 50,
      newBalance: -20,
      balanceWentNegative: true,
      idempotencyKey: 'reverse-1',
    });
    expect(recordReversalTransaction).toHaveBeenCalledWith({
      organizationId: 'org-1',
      original: confirmedEarn(),
      idempotencyKey: 'reverse-1',
      reason: 'Chargeback from payment provider',
      evaluateRefund: evaluateVoucherRefund,
    });
  });

  it('reverses a CONFIRMED redeem and reports a non-negative balance', async () => {
    const repo = stub<CreditsRepository>({
      findTransactionByIdempotency: async () => undefined,
      findTransactionByIdForOrganization: async () => confirmedEarn({ transactionType: 'REDEEM' }),
      recordReversalTransaction: async () => ({
        reversal: buildLoyaltyTransaction({ id: 'tx-reversal-2', idempotencyKey: 'reverse-1', pointsAmount: 50 }),
        reversedOriginal: confirmedEarn({ status: 'REVERSED' }),
        newBalance: 80,
      }),
    });

    const result = await new ReversalService(repo).reverseTransaction('org-1', reverse());

    expect(result.balanceWentNegative).toBe(false);
    expect(result.newBalance).toBe(80);
  });

  it('the same idempotency key replays the same result instead of reversing twice', async () => {
    const repo = stub<CreditsRepository>({
      findTransactionByIdempotency: async (_orgId: string, key: string) =>
        key === 'reverse-1'
          ? buildLoyaltyTransaction({
              id: 'tx-reversal-1',
              transactionType: 'REVERSAL',
              idempotencyKey: 'reverse-1',
              reversesTransactionId: 'tx-earn-1',
            })
          : undefined,
      recordReversalTransaction: () => expect.fail('should not be called on idempotent replay'),
      getOrCreateCreditOwnership: async () => ({ confirmedBalance: 30 }),
    });

    const result = await new ReversalService(repo).reverseTransaction('org-1', reverse());

    expect(result).toMatchObject({
      reversalTransactionId: 'tx-reversal-1',
      reversedTransactionId: 'tx-earn-1',
      newBalance: 30,
      balanceWentNegative: false,
    });
  });

  it('a replayed key whose reversal left the balance negative still reports the debt', async () => {
    const repo = stub<CreditsRepository>({
      findTransactionByIdempotency: async () =>
        buildLoyaltyTransaction({ transactionType: 'REVERSAL', reversesTransactionId: 'tx-earn-1' }),
      getOrCreateCreditOwnership: async () => ({ confirmedBalance: -5 }),
    });

    const result = await new ReversalService(repo).reverseTransaction('org-1', reverse());

    expect(result.balanceWentNegative).toBe(true);
  });

  it('an idempotency key already used by a non-reversal operation is a conflict', async () => {
    const repo = stub<CreditsRepository>({
      findTransactionByIdempotency: async () => confirmedEarn({ transactionType: 'EARN' }),
    });

    await expect(new ReversalService(repo).reverseTransaction('org-1', reverse())).rejects.toMatchObject({
      name: 'ConflictException',
      message: expect.stringMatching(/already used for a different operation/),
    });
  });

  it('rejects reversing a transaction that is not CONFIRMED', async () => {
    const repo = stub<CreditsRepository>({
      findTransactionByIdempotency: async () => undefined,
      findTransactionByIdForOrganization: async () => confirmedEarn({ status: 'REVERSED' }),
    });

    await expect(
      new ReversalService(repo).reverseTransaction('org-1', reverse({ idempotencyKey: 'reverse-2' })),
    ).rejects.toThrow(/already been reversed/);
  });

  it('rejects reversing a PENDING transaction with its current status in the message', async () => {
    const repo = stub<CreditsRepository>({
      findTransactionByIdempotency: async () => undefined,
      findTransactionByIdForOrganization: async () => confirmedEarn({ status: 'PENDING' }),
    });

    await expect(new ReversalService(repo).reverseTransaction('org-1', reverse())).rejects.toThrow(
      /Only a CONFIRMED transaction can be reversed \(current status: PENDING\)/,
    );
  });

  it('rejects reversing a transaction belonging to another organization', async () => {
    const repo = stub<CreditsRepository>({
      findTransactionByIdempotency: async () => undefined,
      findTransactionByIdForOrganization: async (orgId: string) => (orgId === 'org-1' ? confirmedEarn() : undefined),
    });

    await expect(
      new ReversalService(repo).reverseTransaction('org-2', reverse({ idempotencyKey: 'reverse-3' })),
    ).rejects.toThrow(/was not found/);
  });

  it.each(['REVERSAL', 'EXPIRY'] as const)('a %s transaction cannot itself be reversed', async (transactionType) => {
    const repo = stub<CreditsRepository>({
      findTransactionByIdempotency: async () => undefined,
      findTransactionByIdForOrganization: async () => confirmedEarn({ transactionType }),
    });

    await expect(
      new ReversalService(repo).reverseTransaction('org-1', reverse({ transactionId: 'tx-reversal-1' })),
    ).rejects.toThrow(/cannot be reversed/);
  });

  it('requires a non-blank reason', async () => {
    const repo = stub<CreditsRepository>({
      findTransactionByIdempotency: async () => undefined,
      findTransactionByIdForOrganization: () => expect.fail('reason is validated before the lookup'),
    });

    await expect(new ReversalService(repo).reverseTransaction('org-1', reverse({ reason: '  ' }))).rejects.toThrow(
      /reason is required/,
    );
  });

  it('a concurrent double reversal is rejected (race caught by the unique index)', async () => {
    const repo = stub<CreditsRepository>({
      findTransactionByIdempotency: async () => undefined,
      findTransactionByIdForOrganization: async () => confirmedEarn(),
      recordReversalTransaction: async () => {
        throw new Error(
          'duplicate key value violates unique constraint "loyalty_transactions_reverses_transaction_id_unique"',
        );
      },
    });

    await expect(
      new ReversalService(repo).reverseTransaction('org-1', reverse({ idempotencyKey: 'reverse-6' })),
    ).rejects.toMatchObject({
      name: 'ConflictException',
      message: expect.stringMatching(/unique constraint/),
    });
  });

  it('a voucher claim whose coupon was already used is a conflict naming the coupon status', async () => {
    const repo = stub<CreditsRepository>({
      findTransactionByIdempotency: async () => undefined,
      findTransactionByIdForOrganization: async () => confirmedEarn({ transactionType: 'REDEEM' }),
      recordReversalTransaction: async () => {
        throw new VoucherClaimNotReversibleError('REDEEMED');
      },
    });

    await expect(new ReversalService(repo).reverseTransaction('org-1', reverse())).rejects.toMatchObject({
      name: 'ConflictException',
      message: expect.stringMatching(/coupon is REDEEMED/),
    });
  });

  it('a non-Error failure becomes a generic conflict', async () => {
    const repo = stub<CreditsRepository>({
      findTransactionByIdempotency: async () => undefined,
      findTransactionByIdForOrganization: async () => confirmedEarn(),
      recordReversalTransaction: async () => {
        throw 42;
      },
    });

    await expect(new ReversalService(repo).reverseTransaction('org-1', reverse())).rejects.toThrow(
      'Failed to reverse transaction',
    );
  });
});
