import { describe, expect, it, vi } from 'vitest';
import { ChainSubmitProcessor } from '#domain/credits/chain-submit.processor.js';
import type { CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import type { OperationsRepository } from '#infra/db/repositories/operations.repository.js';
import type { SuiClientService } from '#infra/clients/sui/sui.client.js';
import type { ProgramsRepository } from '#infra/db/repositories/programs.repository.js';
import { stub } from '../../../helpers/stub.js';
import {
  PROGRAMS_REPO,
  buildOperation,
  buildProgramRow,
  fakeChainResult,
  programConfigFor,
  programsRepoFor,
} from '../../../helpers/fixtures.js';

const earned = (amount = '100', extra: Record<string, unknown> = {}) =>
  fakeChainResult({ events: [{ type: 'pkg::credit_account::CreditEarned', parsedJson: { amount, ...extra } }] });

const existingAccount = async () => ({ id: 'ownership-1', suiCreditAccountId: '0xexisting' });

type SuiDouble = { [K in keyof SuiClientService]?: unknown } & {
  /**
   * A one-shot earn, the shape most cases want: `signEarn` captures the call (digest `DIGEST1`,
   * expiration epoch 7) and `execute` runs it, the way the processor sends a signed earn (OCT-52).
   */
  earn?: (program: unknown, params: unknown) => unknown;
};

function processor(
  operationsRepo: { [K in keyof OperationsRepository]?: unknown },
  creditsRepo: { [K in keyof CreditsRepository]?: unknown },
  suiClient: SuiDouble,
  programsRepo: ProgramsRepository = PROGRAMS_REPO,
) {
  const { earn, ...rest } = suiClient;
  const sui = earn
    ? {
        signEarn: async (program: unknown, params: unknown) => ({
          program,
          params,
          digest: 'DIGEST1',
          expirationEpoch: 7n,
        }),
        execute: async (signed: { program: unknown; params: unknown }) => earn(signed.program, signed.params),
        ...rest,
      }
    : rest;
  return new ChainSubmitProcessor(
    stub<OperationsRepository>({ recordSubmitDigest: async () => {}, ...operationsRepo }),
    stub<CreditsRepository>(creditsRepo),
    stub<SuiClientService>({ issuerAddress: () => '0xissuer', ...sui }),
    programsRepo,
  );
}

describe('ChainSubmitProcessor', () => {
  it('opens an account under the member’s real address, earns, and confirms on success', async () => {
    const openAccount = vi.fn(async () =>
      fakeChainResult({
        events: [{ type: 'pkg::credit_account::CreditAccountOpened', parsedJson: { account_id: '0xacc1' } }],
      }),
    );
    const earn = vi.fn(async () => earned());
    const setSuiCreditAccountId = vi.fn(async () => {});
    const confirmEarnOnChain = vi.fn(async () => ({ id: 'btx-1' }));
    const markSubmitted = vi.fn(async () => {});

    await processor(
      { markSubmitted, markFailed: () => expect.fail('should not mark failed on success') },
      {
        getCreditOwnershipByEndUserId: async () => ({ id: 'ownership-1', suiCreditAccountId: null }),
        findBeneficiaryAddress: async () => '0xbeneficiary',
        setSuiCreditAccountId,
        confirmEarnOnChain,
        failEarnOnChain: () => expect.fail('should not fail on success'),
      },
      { openAccount, earn },
    ).process(buildOperation());

    // OCT-55: must open under the member's real zkLogin address, never a placeholder.
    expect(openAccount).toHaveBeenCalledWith(programConfigFor('org-1'), '0xbeneficiary');
    expect(setSuiCreditAccountId).toHaveBeenCalledWith('ownership-1', '0xacc1');
    expect(earn).toHaveBeenCalledWith(programConfigFor('org-1'), {
      accountId: '0xacc1',
      purchaseAmount: 10000,
      operationKey: 'idem-chain-1',
    });
    expect(confirmEarnOnChain).toHaveBeenCalledWith({
      loyaltyTransactionId: 'tx-1',
      organizationEndUserId: 'user-1',
      reservedPointsAmount: 10000,
      confirmedPointsAmount: 100,
      bucketExpiresAtMs: null,
      digest: 'DIGEST1',
      sender: '0xissuer',
    });
    expect(markSubmitted).toHaveBeenCalledWith('op-1', 'DIGEST1');
  });

  it('reuses an existing on-chain account without reopening', async () => {
    const earn = vi.fn(async () => earned('50'));
    const markSubmitted = vi.fn(async () => {});

    await processor(
      { markSubmitted },
      { getCreditOwnershipByEndUserId: existingAccount, confirmEarnOnChain: async () => ({ id: 'btx-1' }) },
      { openAccount: () => expect.fail('should not reopen an existing account'), earn },
    ).process(buildOperation());

    expect(earn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: '0xexisting' }));
    expect(markSubmitted).toHaveBeenCalledOnce();
  });

  it('still settles the operation when the indexer already confirmed the row (confirm returns null)', async () => {
    const markSubmitted = vi.fn(async () => {});

    await processor(
      { markSubmitted },
      { getCreditOwnershipByEndUserId: existingAccount, confirmEarnOnChain: async () => null },
      { earn: async () => earned() },
    ).process(buildOperation());

    expect(markSubmitted).toHaveBeenCalledWith('op-1', 'DIGEST1');
  });

  it('the confirmed earn carries its on-chain bucket expiry', async () => {
    const confirmEarnOnChain = vi.fn(async () => ({ id: 'btx-1' }));

    await processor(
      { markSubmitted: async () => {} },
      { getCreditOwnershipByEndUserId: existingAccount, confirmEarnOnChain },
      { earn: async () => earned('100', { bucket_expires_at_ms: '1794560971900' }) },
    ).process(buildOperation());

    expect(confirmEarnOnChain).toHaveBeenCalledWith(expect.objectContaining({ bucketExpiresAtMs: 1794560971900 }));
  });

  it('reverts the pending reservation when the chain call fails', async () => {
    const failEarnOnChain = vi.fn(async () => {});
    const markFailed = vi.fn(async () => {});

    await processor(
      { markFailed },
      {
        getCreditOwnershipByEndUserId: existingAccount,
        confirmEarnOnChain: () => expect.fail('should not confirm on failure'),
        failEarnOnChain,
      },
      { earn: async () => fakeChainResult({ status: 'failure', errorMessage: 'EInsufficientBalance' }) },
    ).process(buildOperation());

    expect(failEarnOnChain).toHaveBeenCalledWith({
      loyaltyTransactionId: 'tx-1',
      organizationEndUserId: 'user-1',
      reservedPointsAmount: 10000,
    });
    expect(markFailed).toHaveBeenCalledWith('op-1', 'EInsufficientBalance');
  });

  it.each([
    [
      'no credit ownership',
      { getCreditOwnershipByEndUserId: async () => undefined },
      {},
      /No credit ownership for end user user-1/,
    ],
    [
      'no beneficiary address',
      {
        getCreditOwnershipByEndUserId: async () => ({ id: 'o-1', suiCreditAccountId: null }),
        findBeneficiaryAddress: async () => null,
      },
      {},
      /No real Sui address on file/,
    ],
    [
      'open_account failed on-chain',
      {
        getCreditOwnershipByEndUserId: async () => ({ id: 'o-1', suiCreditAccountId: null }),
        findBeneficiaryAddress: async () => '0xb',
      },
      { openAccount: async () => fakeChainResult({ status: 'failure', errorMessage: 'EPaused' }) },
      /EPaused/,
    ],
    [
      'open_account failed without a message',
      {
        getCreditOwnershipByEndUserId: async () => ({ id: 'o-1', suiCreditAccountId: null }),
        findBeneficiaryAddress: async () => '0xb',
      },
      { openAccount: async () => fakeChainResult({ status: 'failure' }) },
      /open_account failed on-chain/,
    ],
    [
      'open_account emitted no CreditAccountOpened',
      {
        getCreditOwnershipByEndUserId: async () => ({ id: 'o-1', suiCreditAccountId: null }),
        findBeneficiaryAddress: async () => '0xb',
      },
      { openAccount: async () => fakeChainResult() },
      /did not emit CreditAccountOpened/,
    ],
    [
      'earn failed without a message',
      { getCreditOwnershipByEndUserId: existingAccount },
      { earn: async () => fakeChainResult({ status: 'failure' }) },
      /earn failed on-chain/,
    ],
    [
      'earn emitted no CreditEarned',
      { getCreditOwnershipByEndUserId: existingAccount },
      { earn: async () => fakeChainResult() },
      /emitted no CreditEarned/,
    ],
  ])(
    'a definitive failure (%s) releases the hold and marks FAILED',
    async (_label, creditsRepo, suiClient, message) => {
      const failEarnOnChain = vi.fn(async () => {});
      const markFailed = vi.fn(async () => {});

      await processor({ markFailed }, { ...creditsRepo, failEarnOnChain }, suiClient).process(buildOperation());

      expect(failEarnOnChain).toHaveBeenCalledOnce();
      expect(markFailed).toHaveBeenCalledWith('op-1', expect.stringMatching(message));
    },
  );

  it('stringifies a non-Error failure before marking FAILED', async () => {
    const markFailed = vi.fn(async () => {});

    await processor(
      { markFailed },
      {
        getCreditOwnershipByEndUserId: async () => {
          throw 'db gone';
        },
        failEarnOnChain: async () => {},
      },
      {},
    ).process(buildOperation());

    expect(markFailed).toHaveBeenCalledWith('op-1', 'db gone');
  });

  it('rejects an unsupported command type without touching chain state', async () => {
    const markFailed = vi.fn(async () => {});

    await processor(
      { markFailed },
      { getCreditOwnershipByEndUserId: () => expect.fail('should not look up ownership') },
      { earn: () => expect.fail('should not call chain') },
    ).process(buildOperation({ commandType: 'SOMETHING_ELSE' }));

    expect(markFailed).toHaveBeenCalledWith('op-1', expect.stringMatching(/Unsupported commandType/));
  });

  it('a PG failure after the earn landed leaves it UNKNOWN for the indexer, never FAILED', async () => {
    const markUnknown = vi.fn(async () => true);

    await processor(
      { markFailed: () => expect.fail('should not mark FAILED'), markUnknown },
      {
        getCreditOwnershipByEndUserId: existingAccount,
        confirmEarnOnChain: async () => {
          throw new Error('connection reset');
        },
        failEarnOnChain: () => expect.fail('must not release the hold for points that landed on-chain'),
      },
      { earn: async () => earned() },
    ).process(buildOperation());

    expect(markUnknown).toHaveBeenCalledWith('op-1', 'connection reset', 'DIGEST1');
  });

  it('a non-Error PG failure after landing is stringified into the UNKNOWN message', async () => {
    const markUnknown = vi.fn(async () => true);

    await processor(
      { markUnknown },
      {
        getCreditOwnershipByEndUserId: existingAccount,
        confirmEarnOnChain: async () => {
          throw 'socket closed';
        },
      },
      { earn: async () => earned() },
    ).process(buildOperation());

    expect(markUnknown).toHaveBeenCalledWith('op-1', 'socket closed', 'DIGEST1');
  });

  it('an earn call that throws (outcome unknown) keeps the hold and goes UNKNOWN, not FAILED', async () => {
    const markUnknown = vi.fn(async () => true);

    await processor(
      { markFailed: () => expect.fail('FAILED would invite a retry under a new key (double earn)'), markUnknown },
      {
        getCreditOwnershipByEndUserId: existingAccount,
        confirmEarnOnChain: () => expect.fail('nothing to confirm yet'),
        failEarnOnChain: () => expect.fail('the earn may have landed; the hold must stay'),
      },
      {
        earn: async () => {
          throw new Error('DEADLINE_EXCEEDED waiting for checkpoint');
        },
      },
    ).process(buildOperation());

    expect(markUnknown).toHaveBeenCalledWith(
      'op-1',
      'earn outcome unknown: DEADLINE_EXCEEDED waiting for checkpoint',
      undefined,
    );
  });

  it('an earn call that throws a non-Error is still treated as outcome unknown', async () => {
    const markUnknown = vi.fn(async () => true);

    await processor(
      { markUnknown },
      { getCreditOwnershipByEndUserId: existingAccount },
      {
        earn: async () => {
          throw 'grpc down';
        },
      },
    ).process(buildOperation());

    expect(markUnknown).toHaveBeenCalledWith('op-1', 'earn outcome unknown: grpc down', undefined);
  });

  it('leaves the row alone when the indexer already settled it (markUnknown finds it no longer PROCESSING)', async () => {
    const markUnknown = vi.fn(async () => false);

    await expect(
      processor(
        { markUnknown },
        {
          getCreditOwnershipByEndUserId: existingAccount,
          confirmEarnOnChain: async () => {
            throw new Error('connection reset');
          },
        },
        { earn: async () => earned() },
      ).process(buildOperation()),
    ).resolves.toBeUndefined();

    expect(markUnknown).toHaveBeenCalledOnce();
  });
});

describe('ChainSubmitProcessor per-organization programs (OCT-73)', () => {
  it('dispatches each organization against its own program', async () => {
    const earn = vi.fn<(program: unknown, params: unknown) => Promise<ReturnType<typeof earned>>>(async () =>
      earned('1'),
    );
    const run = processor(
      { markSubmitted: async () => {} },
      { getCreditOwnershipByEndUserId: existingAccount, confirmEarnOnChain: async () => ({ id: 'btx-1' }) },
      { earn },
      programsRepoFor({ 'org-1': buildProgramRow('org-1'), 'org-2': buildProgramRow('org-2') }),
    );

    await run.process(buildOperation({ tenantId: 'org-1' }));
    await run.process(buildOperation({ tenantId: 'org-2' }));

    expect(earn.mock.calls.map(([program]) => program)).toEqual([programConfigFor('org-1'), programConfigFor('org-2')]);
  });

  it('an organization without a program fails the earn before any chain call, never falling back', async () => {
    const failEarnOnChain = vi.fn(async () => {});
    const markFailed = vi.fn(async () => {});

    await processor(
      { markFailed },
      { getCreditOwnershipByEndUserId: () => expect.fail('must not reach the ownership lookup'), failEarnOnChain },
      { openAccount: () => expect.fail('must not open an account'), earn: () => expect.fail('must not call chain') },
      programsRepoFor({}),
    ).process(buildOperation({ tenantId: 'org-unprovisioned' }));

    expect(failEarnOnChain).toHaveBeenCalledWith(expect.objectContaining({ reservedPointsAmount: 10000 }));
    expect(markFailed).toHaveBeenCalledWith(
      'op-1',
      expect.stringMatching(/org-unprovisioned has no on-chain program provisioned/),
    );
  });
});

describe('ChainSubmitProcessor digest-first submit (OCT-52)', () => {
  it('records the digest and expiration before sending, and keeps it when execute throws', async () => {
    const order: string[] = [];
    const markUnknown = vi.fn(async () => true);

    await processor(
      {
        recordSubmitDigest: async (id: string, digest: string, epoch: bigint) =>
          order.push(`record:${id}:${digest}:${epoch}`),
        markUnknown,
        markFailed: () => expect.fail('an outcome-unknown execute is not FAILED'),
      },
      {
        getCreditOwnershipByEndUserId: existingAccount,
        failEarnOnChain: () => expect.fail('the earn may have landed'),
      },
      {
        signEarn: async () => {
          order.push('sign');
          return { digest: 'DIGEST-PRE', expirationEpoch: 42n };
        },
        execute: async () => {
          order.push('execute');
          throw new Error('connection reset');
        },
      },
    ).process(buildOperation());

    expect(order).toEqual(['sign', 'record:op-1:DIGEST-PRE:42', 'execute']);
    expect(markUnknown).toHaveBeenCalledWith('op-1', 'earn outcome unknown: connection reset', undefined);
  });

  it('a build/sign error is definitive: nothing recorded, nothing sent, hold released', async () => {
    const failEarnOnChain = vi.fn(async () => {});
    const markFailed = vi.fn(async () => {});

    await processor(
      {
        recordSubmitDigest: () => expect.fail('nothing was built'),
        markFailed,
        markUnknown: () => expect.fail('not ambiguous'),
      },
      { getCreditOwnershipByEndUserId: existingAccount, failEarnOnChain },
      {
        signEarn: async () => {
          throw new Error('InsufficientGas while resolving');
        },
        execute: () => expect.fail('nothing may be sent after a build error'),
      },
    ).process(buildOperation());

    expect(failEarnOnChain).toHaveBeenCalledWith(expect.objectContaining({ reservedPointsAmount: 10000 }));
    expect(markFailed).toHaveBeenCalledWith('op-1', 'InsufficientGas while resolving');
  });
});

describe('ChainSubmitProcessor reversal mirroring (OCT-50)', () => {
  const reversalOp = (overrides: Record<string, unknown> = {}) =>
    buildOperation({
      id: 'op-rev',
      commandType: 'CREDIT_REVERSAL_CHAIN_SUBMIT',
      idempotencyKey: 'reversal:rev-1',
      payload: {
        reversalTransactionId: 'rev-1',
        reversedTransactionId: 'tx-1',
        reversedTransactionType: 'EARN',
        organizationEndUserId: 'user-1',
        chainKey: 'idem-earn-1',
        ...overrides,
      },
    });
  const signed = { bytes: new Uint8Array([1]), signature: 'sig', digest: 'DIGEST-R', expirationEpoch: 9n };

  function reversalProcessor(sui: Record<string, unknown>, ops: Record<string, unknown> = {}, credits = {}) {
    const operationsRepo = {
      recordSubmitDigest: vi.fn(async () => {}),
      markSubmitted: vi.fn(async () => {}),
      markFailed: vi.fn(async () => {}),
      markUnknown: vi.fn(async () => true),
      ...ops,
    };
    const creditsRepo = {
      getCreditOwnershipByEndUserId: existingAccount,
      recordReversalOnChain: vi.fn(async () => ({ id: 'btx-r' })),
      ...credits,
    };
    return {
      operationsRepo,
      creditsRepo,
      run: (operation: ReturnType<typeof buildOperation>) =>
        processor(operationsRepo, creditsRepo, sui).process(operation),
    };
  }

  it('reverses an earn by its operation key, records the digest first, then links the chain proof', async () => {
    const calls: string[] = [];
    const signReverseEarn = vi.fn(async () => {
      calls.push('sign');
      return signed;
    });
    const execute = vi.fn(async () => {
      calls.push('execute');
      return fakeChainResult({ digest: 'DIGEST-R' });
    });
    const { operationsRepo, creditsRepo, run } = reversalProcessor(
      { signReverseEarn, signReverseRedeem: () => expect.fail('not a redeem'), execute },
      {
        recordSubmitDigest: vi.fn(async () => {
          calls.push('record');
        }),
      },
    );

    await run(reversalOp());

    expect(calls).toEqual(['sign', 'record', 'execute']);
    expect(signReverseEarn).toHaveBeenCalledWith(programConfigFor('org-1'), {
      accountId: '0xexisting',
      operationKey: 'idem-earn-1',
    });
    expect(operationsRepo.recordSubmitDigest).toHaveBeenCalledWith('op-rev', 'DIGEST-R', 9n);
    expect(creditsRepo.recordReversalOnChain).toHaveBeenCalledWith({
      reversalTransactionId: 'rev-1',
      digest: 'DIGEST-R',
      sender: '0xissuer',
    });
    expect(operationsRepo.markSubmitted).toHaveBeenCalledWith('op-rev', 'DIGEST-R');
    expect(operationsRepo.markFailed).not.toHaveBeenCalled();
  });

  it('reverses a POS redemption by its reference', async () => {
    const signReverseRedeem = vi.fn(async () => signed);
    const { operationsRepo, run } = reversalProcessor({
      signReverseEarn: () => expect.fail('not an earn'),
      signReverseRedeem,
      execute: async () => fakeChainResult({ digest: 'DIGEST-R' }),
    });

    await run(reversalOp({ reversedTransactionType: 'REDEEM', chainKey: 'tx-redeem-1' }));

    expect(signReverseRedeem).toHaveBeenCalledWith(programConfigFor('org-1'), {
      accountId: '0xexisting',
      reference: 'tx-redeem-1',
    });
    expect(operationsRepo.markSubmitted).toHaveBeenCalledWith('op-rev', 'DIGEST-R');
  });

  it('a definitive on-chain abort (e.g. an already-spent bucket) marks it FAILED with the reason', async () => {
    const { operationsRepo, creditsRepo, run } = reversalProcessor({
      signReverseEarn: async () => signed,
      execute: async () => fakeChainResult({ status: 'failure', errorMessage: 'MoveAbort ... 6' }),
    });

    await run(reversalOp());

    expect(operationsRepo.markFailed).toHaveBeenCalledWith('op-rev', 'MoveAbort ... 6');
    expect(creditsRepo.recordReversalOnChain).not.toHaveBeenCalled();
  });

  it('fails without signing anything when the member has no on-chain account', async () => {
    const signReverseEarn = vi.fn();
    const { operationsRepo, run } = reversalProcessor(
      { signReverseEarn },
      {},
      { getCreditOwnershipByEndUserId: async () => ({ id: 'ownership-1', suiCreditAccountId: null }) },
    );

    await run(reversalOp());

    expect(signReverseEarn).not.toHaveBeenCalled();
    expect(operationsRepo.markFailed).toHaveBeenCalledWith(
      'op-rev',
      expect.stringMatching(/No on-chain credit account/),
    );
  });

  it('an execute that throws leaves it UNKNOWN for the reconciler, never FAILED or resent', async () => {
    const { operationsRepo, run } = reversalProcessor({
      signReverseEarn: async () => signed,
      execute: async () => {
        throw new Error('socket hang up');
      },
    });

    await run(reversalOp());

    expect(operationsRepo.markUnknown).toHaveBeenCalledWith(
      'op-rev',
      'reversal outcome unknown: socket hang up',
      undefined,
    );
    expect(operationsRepo.markFailed).not.toHaveBeenCalled();
  });

  it('a PG failure after the reversal landed goes UNKNOWN with its digest', async () => {
    const { operationsRepo, run } = reversalProcessor(
      { signReverseEarn: async () => signed, execute: async () => fakeChainResult({ digest: 'DIGEST-R' }) },
      {},
      {
        recordReversalOnChain: async () => {
          throw new Error('connection reset');
        },
      },
    );

    await run(reversalOp());

    expect(operationsRepo.markUnknown).toHaveBeenCalledWith('op-rev', 'connection reset', 'DIGEST-R');
    expect(operationsRepo.markSubmitted).not.toHaveBeenCalled();
  });
});
