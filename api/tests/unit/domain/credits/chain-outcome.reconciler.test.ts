import { describe, expect, it, vi } from 'vitest';
import type { SubmittedChainTransaction } from '@octap/chain';
import {
  ChainOutcomeReconciler,
  EARN_COMMAND_TYPE,
  REVERSAL_COMMAND_TYPE,
} from '#domain/credits/chain-outcome.reconciler.js';
import {
  ABANDONED_POS_HOLD_GRACE_MS,
  CUSTOMER_REDEEM_COMMAND_TYPES,
  POS_RESERVE_COMMAND_TYPE,
  VOUCHER_CLAIM_RESERVE_COMMAND_TYPE,
  type CreditsRepository,
} from '#infra/db/repositories/credits.repository.js';
import type { OperationsRepository } from '#infra/db/repositories/operations.repository.js';
import type { SuiClientService } from '#infra/clients/sui/sui.client.js';
import type { SuiTransactionBuilderClient } from '#infra/clients/sui/sui-transaction-builder.client.js';
import { stub } from '../../../helpers/stub.js';
import { buildLoyaltyTransaction, buildOperation } from '../../../helpers/fixtures.js';

type Operation = ReturnType<typeof buildOperation>;

const unknownEarn = (overrides: Partial<Operation> = {}) =>
  buildOperation({ status: 'UNKNOWN', suiTxDigest: 'DIGEST-E', suiTxExpirationEpoch: 10n, ...overrides });

const posFinalize = (overrides: Partial<Operation> = {}) =>
  buildOperation({
    id: 'op-pos',
    commandType: POS_RESERVE_COMMAND_TYPE,
    idempotencyKey: 'pos-idem-1',
    status: 'PENDING',
    suiTxDigest: 'DIGEST-P',
    suiTxExpirationEpoch: 5n,
    payload: { organizationEndUserId: 'user-1', pointsAmount: 80 },
    ...overrides,
  });

const landed = (digest: string, events: SubmittedChainTransaction['events'] = []): SubmittedChainTransaction => ({
  digest,
  status: 'success',
  events,
});

function fixture({
  operations,
  outcomes = {},
  epoch = 10n,
  creditsRepo = {},
}: {
  operations: Operation[];
  outcomes?: Record<string, SubmittedChainTransaction>;
  epoch?: bigint;
  creditsRepo?: { [K in keyof CreditsRepository]?: unknown };
}) {
  const ops = {
    listUnresolvedChainOutcomes: vi.fn(async () => operations),
    settleFromChain: vi.fn(async () => true),
    touch: vi.fn(async () => {}),
  };
  const credits = {
    confirmEarnOnChain: vi.fn(async () => ({ id: 'btx' })),
    failEarnOnChain: vi.fn(async () => {}),
    confirmPosRedemptionOnChain: vi.fn(async () => ({ id: 'btx' })),
    failPosRedemptionOnChain: vi.fn(async () => {}),
    findTransactionByIdempotency: vi.fn(async () =>
      buildLoyaltyTransaction({ id: 'tx-pos-1', transactionType: 'REDEEM' }),
    ),
    findBeneficiaryAddress: vi.fn(async () => '0xbeneficiary'),
    ...creditsRepo,
  };
  const reader = {
    findTransaction: vi.fn(async (digest: string) => outcomes[digest] ?? null),
    currentEpoch: vi.fn(async () => epoch),
  };
  const reconciler = new ChainOutcomeReconciler(
    stub<OperationsRepository>(ops),
    stub<CreditsRepository>(credits),
    stub<SuiTransactionBuilderClient>(reader),
    // Only the issuer address: reconciling never signs or sends anything.
    stub<SuiClientService>({ issuerAddress: () => '0xissuer' }),
  );
  return { ops, credits, reader, reconciler };
}

describe('ChainOutcomeReconciler', () => {
  it('lists unresolved earns and POS finalizes past the grace period', async () => {
    const { ops, reconciler } = fixture({ operations: [] });

    await expect(reconciler.reconcileOnce()).resolves.toEqual([]);
    expect(ops.listUnresolvedChainOutcomes).toHaveBeenCalledWith({
      unknownCommandTypes: [EARN_COMMAND_TYPE, REVERSAL_COMMAND_TYPE],
      customerRedeemCommandTypes: CUSTOMER_REDEEM_COMMAND_TYPES,
      abandonedUnsignedCommandType: VOUCHER_CLAIM_RESERVE_COMMAND_TYPE,
      abandonedAfterMs: ABANDONED_POS_HOLD_GRACE_MS,
      olderThanMs: 5 * 60 * 1000,
      limit: 20,
    });
  });

  const unsignedClaim = () =>
    posFinalize({ commandType: VOUCHER_CLAIM_RESERVE_COMMAND_TYPE, suiTxDigest: null, suiTxExpirationEpoch: null });

  it('abandons an unsigned voucher claim, releasing its hold before settling the command', async () => {
    const failPosRedemptionOnChain = vi.fn(async () => true);
    const { reconciler, ops, reader } = fixture({
      operations: [unsignedClaim()],
      creditsRepo: { failPosRedemptionOnChain },
    });
    await expect(reconciler.reconcileOnce()).resolves.toEqual(['failed']);
    expect(failPosRedemptionOnChain).toHaveBeenCalledWith({
      loyaltyTransactionId: 'tx-pos-1',
      organizationEndUserId: 'user-1',
      pointsAmount: 80,
      onlyIfUnsubmitted: true,
    });
    expect(ops.settleFromChain).toHaveBeenCalledWith('op-pos', 'FAILED', expect.stringMatching(/ever sent/));
    expect(reader.findTransaction).not.toHaveBeenCalled();
  });

  it('abandons an unsigned voucher claim but yields if finalize has already pinned its digest', async () => {
    const operation = unsignedClaim();
    const failPosRedemptionOnChain = vi.fn(async () => false);
    const { reconciler, ops } = fixture({ operations: [operation], creditsRepo: { failPosRedemptionOnChain } });
    await expect(reconciler.reconcileOnce()).resolves.toEqual(['waiting']);
    expect(failPosRedemptionOnChain).toHaveBeenCalledWith(expect.objectContaining({ onlyIfUnsubmitted: true }));
    expect(ops.settleFromChain).not.toHaveBeenCalled();
  });

  it('confirms a timed-out earn that landed from its digest, never sending it again', async () => {
    const { ops, credits, reconciler } = fixture({
      operations: [unknownEarn()],
      outcomes: {
        'DIGEST-E': landed('DIGEST-E', [
          {
            type: 'pkg::credit_account::CreditEarned',
            parsedJson: { amount: '100', bucket_expires_at_ms: '1700000000000' },
          },
        ]),
      },
    });

    await expect(reconciler.reconcileOnce()).resolves.toEqual(['confirmed']);
    expect(credits.confirmEarnOnChain).toHaveBeenCalledWith({
      loyaltyTransactionId: 'tx-1',
      organizationEndUserId: 'user-1',
      confirmedPointsAmount: 100,
      bucketExpiresAtMs: 1700000000000,
      digest: 'DIGEST-E',
      sender: '0xissuer',
    });
    expect(ops.settleFromChain).toHaveBeenCalledWith('op-1', 'SUBMITTED');
    expect(credits.failEarnOnChain).not.toHaveBeenCalled();
  });

  it('a landed earn without a bucket expiry confirms with no bucket', async () => {
    const { credits, reconciler } = fixture({
      operations: [unknownEarn()],
      outcomes: {
        'DIGEST-E': landed('DIGEST-E', [{ type: 'pkg::credit_account::CreditEarned', parsedJson: { amount: '100' } }]),
      },
    });

    await reconciler.reconcileOnce();
    expect(credits.confirmEarnOnChain).toHaveBeenCalledWith(expect.objectContaining({ bucketExpiresAtMs: null }));
  });

  it('a landed earn with no CreditEarned event is left for a human, not guessed', async () => {
    const { ops, credits, reconciler } = fixture({
      operations: [unknownEarn()],
      outcomes: { 'DIGEST-E': landed('DIGEST-E') },
    });

    await expect(reconciler.reconcileOnce()).resolves.toEqual(['waiting']);
    expect(credits.confirmEarnOnChain).not.toHaveBeenCalled();
    expect(ops.settleFromChain).not.toHaveBeenCalled();
    expect(ops.touch).toHaveBeenCalledWith('op-1');
  });

  it('a digest that failed on-chain releases the hold and goes FAILED', async () => {
    const { ops, credits, reconciler } = fixture({
      operations: [unknownEarn()],
      outcomes: {
        'DIGEST-E': { digest: 'DIGEST-E', status: 'failure', errorMessage: 'MoveAbort EBudgetExhausted', events: [] },
      },
    });

    await expect(reconciler.reconcileOnce()).resolves.toEqual(['failed']);
    expect(credits.failEarnOnChain).toHaveBeenCalledWith({
      loyaltyTransactionId: 'tx-1',
      organizationEndUserId: 'user-1',
    });
    expect(ops.settleFromChain).toHaveBeenCalledWith('op-1', 'FAILED', 'MoveAbort EBudgetExhausted');
  });

  it('an on-chain failure without a message still names the digest', async () => {
    const { ops, reconciler } = fixture({
      operations: [unknownEarn()],
      outcomes: { 'DIGEST-E': { digest: 'DIGEST-E', status: 'failure', events: [] } },
    });

    await reconciler.reconcileOnce();
    expect(ops.settleFromChain).toHaveBeenCalledWith('op-1', 'FAILED', 'DIGEST-E failed on-chain');
  });

  it('a digest never seen waits while within its expiration, and is FAILED once the chain is past it', async () => {
    const waiting = fixture({ operations: [unknownEarn({ suiTxExpirationEpoch: 10n })], epoch: 10n });
    await expect(waiting.reconciler.reconcileOnce()).resolves.toEqual(['waiting']);
    expect(waiting.credits.failEarnOnChain).not.toHaveBeenCalled();
    expect(waiting.ops.touch).toHaveBeenCalledWith('op-1');

    const expired = fixture({ operations: [unknownEarn({ suiTxExpirationEpoch: 10n })], epoch: 11n });
    await expect(expired.reconciler.reconcileOnce()).resolves.toEqual(['failed']);
    expect(expired.ops.settleFromChain).toHaveBeenCalledWith(
      'op-1',
      'FAILED',
      'DIGEST-E never landed and expired after epoch 10',
    );
  });

  it('a digest with no expiration is never declared dead; it waits for a human', async () => {
    const { ops, reader, reconciler } = fixture({ operations: [unknownEarn({ suiTxExpirationEpoch: null })] });

    await expect(reconciler.reconcileOnce()).resolves.toEqual(['waiting']);
    expect(reader.currentEpoch).not.toHaveBeenCalled();
    expect(ops.settleFromChain).not.toHaveBeenCalled();
  });

  it('an UNKNOWN earn with no digest never sent anything and is released', async () => {
    const { ops, credits, reader, reconciler } = fixture({
      operations: [unknownEarn({ suiTxDigest: null, suiTxExpirationEpoch: null })],
    });

    await expect(reconciler.reconcileOnce()).resolves.toEqual(['failed']);
    expect(reader.findTransaction).not.toHaveBeenCalled();
    expect(credits.failEarnOnChain).toHaveBeenCalledOnce();
    expect(ops.settleFromChain).toHaveBeenCalledWith('op-1', 'FAILED', 'no transaction was ever sent for this command');
  });

  it('reads the current epoch at most once per pass', async () => {
    const { reader, reconciler } = fixture({
      operations: [unknownEarn({ id: 'a', suiTxDigest: 'A' }), unknownEarn({ id: 'b', suiTxDigest: 'B' })],
      epoch: 11n,
    });

    await expect(reconciler.reconcileOnce()).resolves.toEqual(['failed', 'failed']);
    expect(reader.currentEpoch).toHaveBeenCalledOnce();
  });

  it('confirms a POS finalize that landed against its loyalty row and beneficiary', async () => {
    const { ops, credits, reconciler } = fixture({
      operations: [posFinalize()],
      outcomes: { 'DIGEST-P': landed('DIGEST-P') },
    });

    await expect(reconciler.reconcileOnce()).resolves.toEqual(['confirmed']);
    expect(credits.findTransactionByIdempotency).toHaveBeenCalledWith('org-1', 'pos-idem-1');
    expect(credits.confirmPosRedemptionOnChain).toHaveBeenCalledWith({
      loyaltyTransactionId: 'tx-pos-1',
      organizationEndUserId: 'user-1',
      pointsAmount: 80,
      digest: 'DIGEST-P',
      sender: '0xbeneficiary',
    });
    expect(ops.settleFromChain).toHaveBeenCalledWith('op-pos', 'SUBMITTED');
  });

  it('settles a failed POS operation after its loyalty transaction was already settled before a crash', async () => {
    const { ops, reconciler } = fixture({
      operations: [posFinalize()],
      epoch: 6n,
      creditsRepo: { failPosRedemptionOnChain: async () => 'already-settled' },
    });

    await expect(reconciler.reconcileOnce()).resolves.toEqual(['failed']);
    expect(ops.settleFromChain).toHaveBeenCalledWith('op-pos', 'FAILED', expect.stringMatching(/never landed/));
  });

  it('a landed POS finalize with no loyalty row or beneficiary is left for a human', async () => {
    const { ops, credits, reconciler } = fixture({
      operations: [posFinalize()],
      outcomes: { 'DIGEST-P': landed('DIGEST-P') },
      creditsRepo: { findTransactionByIdempotency: async () => undefined },
    });

    await expect(reconciler.reconcileOnce()).resolves.toEqual(['waiting']);
    expect(credits.confirmPosRedemptionOnChain).not.toHaveBeenCalled();
    expect(ops.touch).toHaveBeenCalledWith('op-pos');
  });

  it('releases a POS hold whose digest expired without landing', async () => {
    const { ops, credits, reconciler } = fixture({ operations: [posFinalize()], epoch: 6n });

    await expect(reconciler.reconcileOnce()).resolves.toEqual(['failed']);
    expect(credits.failPosRedemptionOnChain).toHaveBeenCalledWith({
      loyaltyTransactionId: 'tx-pos-1',
      organizationEndUserId: 'user-1',
      pointsAmount: 80,
    });
    expect(ops.settleFromChain).toHaveBeenCalledWith('op-pos', 'FAILED', expect.stringMatching(/never landed/));
  });

  it('settles a failed POS operation even when its loyalty row is gone', async () => {
    const { ops, credits, reconciler } = fixture({
      operations: [posFinalize()],
      epoch: 6n,
      creditsRepo: { findTransactionByIdempotency: async () => undefined },
    });

    await expect(reconciler.reconcileOnce()).resolves.toEqual(['failed']);
    expect(credits.failPosRedemptionOnChain).not.toHaveBeenCalled();
    expect(ops.settleFromChain).toHaveBeenCalledWith('op-pos', 'FAILED', expect.any(String));
  });

  it('an error on one operation is retried later without blocking the rest', async () => {
    const { ops, reader, reconciler } = fixture({
      operations: [unknownEarn({ id: 'op-bad', suiTxDigest: 'BAD' }), unknownEarn({ id: 'op-ok', suiTxDigest: 'OK' })],
      outcomes: { OK: { digest: 'OK', status: 'failure', events: [] } },
    });
    reader.findTransaction.mockRejectedValueOnce(new Error('UNAVAILABLE')).mockRejectedValueOnce('not an Error');

    await expect(reconciler.reconcileOnce()).resolves.toEqual(['waiting', 'waiting']);
    expect(ops.touch.mock.calls).toEqual([['op-bad'], ['op-ok']]);
  });
});

describe('ChainOutcomeReconciler reversals (OCT-50)', () => {
  const unknownReversal = (overrides: Partial<Operation> = {}) =>
    buildOperation({
      id: 'op-rev',
      commandType: REVERSAL_COMMAND_TYPE,
      status: 'UNKNOWN',
      suiTxDigest: 'DIGEST-R',
      suiTxExpirationEpoch: 10n,
      payload: { reversalTransactionId: 'rev-1' },
      ...overrides,
    });

  it('links a reversal that landed and settles it SUBMITTED', async () => {
    const recordReversalOnChain = vi.fn(async () => ({ id: 'btx' }));
    const { ops, reconciler } = fixture({
      operations: [unknownReversal()],
      outcomes: { 'DIGEST-R': landed('DIGEST-R') },
      creditsRepo: { recordReversalOnChain },
    });

    await expect(reconciler.reconcileOnce()).resolves.toEqual(['confirmed']);
    expect(recordReversalOnChain).toHaveBeenCalledWith({
      reversalTransactionId: 'rev-1',
      digest: 'DIGEST-R',
      sender: '0xissuer',
    });
    expect(ops.settleFromChain).toHaveBeenCalledWith('op-rev', 'SUBMITTED');
  });

  it('a reversal that failed or never landed is only marked FAILED: no hold to release', async () => {
    const { ops, credits, reconciler } = fixture({
      operations: [unknownReversal(), unknownReversal({ id: 'op-rev-2', suiTxDigest: null })],
      outcomes: {
        'DIGEST-R': { digest: 'DIGEST-R', status: 'failure', errorMessage: 'EBucketUnavailable', events: [] },
      },
    });

    await expect(reconciler.reconcileOnce()).resolves.toEqual(['failed', 'failed']);
    expect(ops.settleFromChain).toHaveBeenCalledWith('op-rev', 'FAILED', 'EBucketUnavailable');
    expect(ops.settleFromChain).toHaveBeenCalledWith(
      'op-rev-2',
      'FAILED',
      'no transaction was ever sent for this command',
    );
    expect(credits.failEarnOnChain).not.toHaveBeenCalled();
    expect(credits.failPosRedemptionOnChain).not.toHaveBeenCalled();
  });
});
