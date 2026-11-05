import { describe, expect, it, vi } from 'vitest';
import { SimulationError } from '@mysten/sui/client';
import { ChainSubmitProcessor } from '#domain/credits/chain-submit.processor.js';
import type { CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import type { OperationsRepository } from '#infra/db/repositories/operations.repository.js';
import type { RewardsRepository } from '#infra/db/repositories/rewards.repository.js';
import type { SuiClientService } from '#infra/clients/sui/sui.client.js';
import type { ProgramsRepository } from '#infra/db/repositories/programs.repository.js';
import { stub } from '../../../helpers/stub.js';
import {
  PROGRAMS_REPO,
  buildOperation,
  buildProgramRow,
  buildVoucher,
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
  rewardsRepo: { [K in keyof RewardsRepository]?: unknown } = {},
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
    stub<RewardsRepository>(rewardsRepo),
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
      failureCode: 'REJECTED',
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

    expect(failEarnOnChain).toHaveBeenCalledOnce();
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

    expect(failEarnOnChain).toHaveBeenCalledWith(expect.objectContaining({ failureCode: 'REJECTED' }));
    expect(markFailed).toHaveBeenCalledWith('op-1', 'InsufficientGas while resolving');
  });

  it('reports an exhausted budget when the executed earn aborts on its budget shard', async () => {
    const failEarnOnChain = vi.fn(async () => {});
    await processor(
      { recordSubmitDigest: async () => {}, markFailed: async () => {} },
      {
        getCreditOwnershipByEndUserId: async () => ({ id: 'ownership-1', suiCreditAccountId: '0xacc1' }),
        failEarnOnChain,
      },
      {
        signEarn: async () => ({ digest: 'DIGEST', bytes: 'b', signature: 's', expirationEpoch: null }),
        execute: async () => ({
          ...fakeChainResult({ status: 'failure', errorMessage: 'MoveAbort' }),
          moveAbort: { module: 'budget_shard', functionName: 'debit', abortCode: '2' },
        }),
      },
    ).process(buildOperation());

    expect(failEarnOnChain).toHaveBeenCalledWith(expect.objectContaining({ failureCode: 'BUDGET_EXHAUSTED' }));
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

describe('ChainSubmitProcessor re-provisioned organization recovery (OCT-244)', () => {
  const CURRENT_PROGRAM = programConfigFor('org-1').programControlId;
  const OLD_PROGRAM = '0xprogram-before-reprovisioning';

  /** A definitive `earn` failure carrying a structured Move abort. */
  const aborted = (module: string, abortCode: string, functionName = 'earn') => ({
    ...fakeChainResult({
      status: 'failure',
      errorMessage: `MoveAbort, abort code: ${abortCode}, in '0xpkg::${module}::${functionName}'`,
    }),
    moveAbort: { module, functionName, abortCode },
  });
  const wrongProgram = () => aborted('credit_account', '0');

  /**
   * A sui double whose earns return `results` in order, each signed with its own digest
   * (DIGEST1, DIGEST2, ...), so a retry is distinguishable from the first attempt.
   */
  function sequencedSui<Extra extends Record<string, unknown>>(results: unknown[], extra: Extra) {
    const earnedOn: string[] = [];
    let n = 0;
    return {
      earnedOn,
      sui: {
        signEarn: async (_program: unknown, params: { accountId: string }) => {
          n += 1;
          return { params, digest: `DIGEST${n}`, expirationEpoch: 7n, attempt: n };
        },
        execute: async (signed: { params: { accountId: string }; attempt: number; digest: string }) => {
          earnedOn.push(signed.params.accountId);
          const result = results[signed.attempt - 1];
          if (result instanceof Error) {
            throw result;
          }
          // Like the chain: the result carries the digest of the bytes that were sent.
          return { ...(result as object), digest: signed.digest };
        },
        ...extra,
      },
    };
  }

  const reopenedAccount = () =>
    fakeChainResult({
      events: [{ type: 'pkg::credit_account::CreditAccountOpened', parsedJson: { account_id: '0xreopened' } }],
    });

  it('clears the stale account, reopens it in the current program, and earns there', async () => {
    const { sui, earnedOn } = sequencedSui([wrongProgram(), earned('100')], {
      creditAccountProgramId: vi.fn(async () => OLD_PROGRAM),
      openAccount: vi.fn(async () => reopenedAccount()),
    });
    const setSuiCreditAccountId = vi.fn(async () => {});
    const recordSubmitDigest = vi.fn(async () => {});
    const confirmEarnOnChain = vi.fn(async () => ({ id: 'btx-1' }));
    const markSubmitted = vi.fn(async () => {});

    await processor(
      { recordSubmitDigest, markSubmitted, markFailed: () => expect.fail('recovered, not failed') },
      {
        getCreditOwnershipByEndUserId: existingAccount,
        findBeneficiaryAddress: async () => '0xbeneficiary',
        setSuiCreditAccountId,
        confirmEarnOnChain,
        failEarnOnChain: () => expect.fail('recovered, the hold stays'),
      },
      sui,
    ).process(buildOperation());

    expect(sui.creditAccountProgramId).toHaveBeenCalledWith('0xexisting');
    // Replaced only once the new account exists: never cleared to nothing in between.
    expect(setSuiCreditAccountId.mock.calls).toEqual([['ownership-1', '0xreopened']]);
    expect(sui.openAccount).toHaveBeenCalledWith(programConfigFor('org-1'), '0xbeneficiary');
    expect(earnedOn).toEqual(['0xexisting', '0xreopened']);
    // Each attempt's digest is recorded before it is sent; the confirmed one is the retry's.
    expect(recordSubmitDigest.mock.calls).toEqual([
      ['op-1', 'DIGEST1', 7n],
      ['op-1', 'DIGEST2', 7n],
    ]);
    expect(confirmEarnOnChain).toHaveBeenCalledWith(
      expect.objectContaining({ digest: 'DIGEST2', confirmedPointsAmount: 100 }),
    );
    expect(markSubmitted).toHaveBeenCalledWith('op-1', 'DIGEST2');
  });

  it('recovers from the abort where it really surfaces: simulated while signing, before anything is sent', async () => {
    // What testnet does (OCT-244 e2e): building the earn simulates it, and the SDK throws a
    // SimulationError carrying the abort, so execute is never reached.
    const simulated = new SimulationError(
      "Transaction resolution failed: MoveAbort in 1st command, abort code: 0, in '0xpkg::credit_account::earn'",
      {
        executionError: {
          $kind: 'MoveAbort',
          message: 'MoveAbort in 1st command, abort code: 0',
          MoveAbort: { abortCode: '0', location: { module: 'credit_account', functionName: 'earn' } },
        } as never,
      },
    );
    const signedFor: string[] = [];
    const recordSubmitDigest = vi.fn(async () => {});
    const setSuiCreditAccountId = vi.fn(async () => {});
    const markSubmitted = vi.fn(async () => {});

    await processor(
      { recordSubmitDigest, markSubmitted, markFailed: () => expect.fail('recovered, not failed') },
      {
        getCreditOwnershipByEndUserId: existingAccount,
        findBeneficiaryAddress: async () => '0xbeneficiary',
        setSuiCreditAccountId,
        confirmEarnOnChain: async () => ({ id: 'btx-1' }),
        failEarnOnChain: () => expect.fail('recovered, the hold stays'),
      },
      {
        signEarn: async (_program: unknown, params: { accountId: string }) => {
          signedFor.push(params.accountId);
          if (params.accountId === '0xexisting') {
            throw simulated;
          }
          return { params, digest: 'DIGEST-RETRY', expirationEpoch: 7n };
        },
        execute: async () => ({ ...earned('500'), digest: 'DIGEST-RETRY' }),
        creditAccountProgramId: async () => OLD_PROGRAM,
        openAccount: async () => reopenedAccount(),
      },
    ).process(buildOperation());

    expect(signedFor).toEqual(['0xexisting', '0xreopened']);
    // The aborted attempt never got a digest: only the retry was recorded and sent.
    expect(recordSubmitDigest.mock.calls).toEqual([['op-1', 'DIGEST-RETRY', 7n]]);
    expect(setSuiCreditAccountId.mock.calls).toEqual([['ownership-1', '0xreopened']]);
    expect(markSubmitted).toHaveBeenCalledWith('op-1', 'DIGEST-RETRY');
  });

  it('a simulated abort that is not EWrongProgram fails the earn with the SDK message, nothing read', async () => {
    const markFailed = vi.fn(async () => {});

    await processor(
      { markFailed },
      {
        getCreditOwnershipByEndUserId: existingAccount,
        setSuiCreditAccountId: () => expect.fail('nothing to clear'),
        failEarnOnChain: async () => {},
      },
      {
        signEarn: async () => {
          throw new SimulationError('Transaction resolution failed: MoveAbort, abort code: 4', {
            executionError: {
              $kind: 'MoveAbort',
              message: 'abort code: 4',
              MoveAbort: { abortCode: '4', location: { module: 'budget_shard', functionName: 'debit' } },
            } as never,
          });
        },
        creditAccountProgramId: () => expect.fail('not recoverable'),
      },
    ).process(buildOperation());

    expect(markFailed).toHaveBeenCalledWith('op-1', expect.stringMatching(/Transaction resolution failed/));
  });

  it('compares program ids as addresses, not raw strings', async () => {
    const { sui, earnedOn } = sequencedSui([wrongProgram()], {
      // Same program, written with leading zeros and upper case: not a re-provisioning.
      creditAccountProgramId: async () => '0x00' + CURRENT_PROGRAM.slice(2).toUpperCase(),
      openAccount: () => expect.fail('same program, nothing to reopen'),
    });

    await processor(
      { markFailed: async () => {} },
      {
        getCreditOwnershipByEndUserId: existingAccount,
        setSuiCreditAccountId: () => expect.fail('nothing to clear'),
        failEarnOnChain: async () => {},
      },
      sui,
    ).process(buildOperation({ tenantId: 'org-1' }));

    expect(earnedOn).toEqual(['0xexisting']);
  });

  it('not re-provisioned: an EWrongProgram whose account is already in the current program changes nothing', async () => {
    // The abort can also mean our IssuerCap is for another program (a bug, not re-provisioning):
    // the account then really is in the organization's current program and must be kept.
    const { sui, earnedOn } = sequencedSui([wrongProgram()], {
      creditAccountProgramId: vi.fn(async () => CURRENT_PROGRAM),
      openAccount: () => expect.fail('must not open a second account for an unaffected member'),
    });
    const failEarnOnChain = vi.fn(async () => {});
    const markFailed = vi.fn(async () => {});

    await processor(
      { markFailed },
      {
        getCreditOwnershipByEndUserId: existingAccount,
        setSuiCreditAccountId: () => expect.fail('must not clear an account that is in the current program'),
        confirmEarnOnChain: () => expect.fail('nothing landed'),
        failEarnOnChain,
      },
      sui,
    ).process(buildOperation());

    expect(sui.creditAccountProgramId).toHaveBeenCalledWith('0xexisting');
    expect(earnedOn).toEqual(['0xexisting']);
    expect(failEarnOnChain).toHaveBeenCalledWith({
      loyaltyTransactionId: 'tx-1',
      organizationEndUserId: 'user-1',
      failureCode: 'REJECTED',
    });
    expect(markFailed).toHaveBeenCalledWith('op-1', expect.stringMatching(/abort code: 0/));
  });

  it('a failed reopen keeps the stale account id, so the old account (and its credits) stays referenced', async () => {
    const { sui } = sequencedSui([wrongProgram()], {
      creditAccountProgramId: async () => OLD_PROGRAM,
      openAccount: async () => fakeChainResult({ status: 'failure', errorMessage: 'InsufficientGas' }),
    });
    const markFailed = vi.fn(async () => {});

    await processor(
      { markFailed },
      {
        getCreditOwnershipByEndUserId: existingAccount,
        findBeneficiaryAddress: async () => '0xbeneficiary',
        setSuiCreditAccountId: () => expect.fail('the stale id must survive a failed reopen'),
        failEarnOnChain: async () => {},
      },
      sui,
    ).process(buildOperation());

    expect(markFailed).toHaveBeenCalledWith('op-1', 'InsufficientGas');
  });

  it('a failed program read keeps the original abort as the failure reason and reopens nothing', async () => {
    const { sui } = sequencedSui([wrongProgram()], {
      creditAccountProgramId: async () => {
        throw new Error('UNAVAILABLE');
      },
      openAccount: () => expect.fail('nothing proven, nothing reopened'),
    });
    const markFailed = vi.fn(async () => {});

    await processor(
      { markFailed },
      {
        getCreditOwnershipByEndUserId: existingAccount,
        setSuiCreditAccountId: () => expect.fail('nothing to clear'),
        failEarnOnChain: async () => {},
      },
      sui,
    ).process(buildOperation());

    expect(markFailed).toHaveBeenCalledWith('op-1', expect.stringMatching(/abort code: 0/));
  });

  it('an account that is not on-chain at all is not reopened either', async () => {
    const { sui, earnedOn } = sequencedSui([wrongProgram()], {
      creditAccountProgramId: async () => null,
      openAccount: () => expect.fail('unexplained abort, leave it for a human'),
    });
    const markFailed = vi.fn(async () => {});

    await processor(
      { markFailed },
      {
        getCreditOwnershipByEndUserId: existingAccount,
        setSuiCreditAccountId: () => expect.fail('nothing to clear'),
        failEarnOnChain: async () => {},
      },
      sui,
    ).process(buildOperation());

    expect(earnedOn).toEqual(['0xexisting']);
    expect(markFailed).toHaveBeenCalledOnce();
  });

  it.each([
    ['another credit_account abort', aborted('credit_account', '3')],
    ["budget_shard's own EWrongProgram (same code, other module)", aborted('budget_shard', '0', 'debit')],
    ['a failure that is not a Move abort', fakeChainResult({ status: 'failure', errorMessage: 'InsufficientGas' })],
  ])('%s never triggers the recovery', async (_label, failure) => {
    const { sui, earnedOn } = sequencedSui([failure], {
      creditAccountProgramId: () => expect.fail('only credit_account::earn EWrongProgram is recoverable'),
      openAccount: () => expect.fail('no reopen'),
    });
    const markFailed = vi.fn(async () => {});

    await processor(
      { markFailed },
      {
        getCreditOwnershipByEndUserId: existingAccount,
        setSuiCreditAccountId: () => expect.fail('nothing to clear'),
        failEarnOnChain: async () => {},
      },
      sui,
    ).process(buildOperation());

    expect(earnedOn).toEqual(['0xexisting']);
    expect(markFailed).toHaveBeenCalledOnce();
  });

  it('an unaffected member earns exactly as before: no program read, no reopen', async () => {
    const { sui, earnedOn } = sequencedSui([earned('100')], {
      creditAccountProgramId: () => expect.fail('a successful earn reads nothing extra'),
      openAccount: () => expect.fail('no reopen'),
    });
    const markSubmitted = vi.fn(async () => {});

    await processor(
      { markSubmitted },
      {
        getCreditOwnershipByEndUserId: existingAccount,
        setSuiCreditAccountId: () => expect.fail('nothing to clear'),
        confirmEarnOnChain: async () => ({ id: 'btx-1' }),
      },
      sui,
    ).process(buildOperation());

    expect(earnedOn).toEqual(['0xexisting']);
    expect(markSubmitted).toHaveBeenCalledWith('op-1', 'DIGEST1');
  });

  it('recovers at most once: a retry that aborts again fails the earn instead of looping', async () => {
    const { sui, earnedOn } = sequencedSui([wrongProgram(), wrongProgram()], {
      creditAccountProgramId: async () => OLD_PROGRAM,
      openAccount: vi.fn(async () => reopenedAccount()),
    });
    const markFailed = vi.fn(async () => {});

    await processor(
      { markFailed },
      {
        getCreditOwnershipByEndUserId: existingAccount,
        findBeneficiaryAddress: async () => '0xbeneficiary',
        setSuiCreditAccountId: async () => {},
        failEarnOnChain: async () => {},
      },
      sui,
    ).process(buildOperation());

    expect(earnedOn).toEqual(['0xexisting', '0xreopened']);
    expect(sui.openAccount).toHaveBeenCalledOnce();
    expect(markFailed).toHaveBeenCalledOnce();
  });

  it('a retry whose execute throws is left UNKNOWN under the retry’s digest, never FAILED', async () => {
    const { sui } = sequencedSui([wrongProgram(), new Error('ETIMEDOUT')], {
      creditAccountProgramId: async () => OLD_PROGRAM,
      openAccount: async () => reopenedAccount(),
    });
    const recordSubmitDigest = vi.fn(async () => {});
    const markUnknown = vi.fn(async () => true);

    await processor(
      { recordSubmitDigest, markUnknown, markFailed: () => expect.fail('outcome unknown, not failed') },
      {
        getCreditOwnershipByEndUserId: existingAccount,
        findBeneficiaryAddress: async () => '0xbeneficiary',
        setSuiCreditAccountId: async () => {},
        failEarnOnChain: () => expect.fail('the hold stays while the outcome is unknown'),
      },
      sui,
    ).process(buildOperation());

    expect(recordSubmitDigest).toHaveBeenLastCalledWith('op-1', 'DIGEST2', 7n);
    expect(markUnknown).toHaveBeenCalledWith('op-1', expect.stringMatching(/ETIMEDOUT/), undefined);
  });
});

describe('ChainSubmitProcessor voucher commands', () => {
  const publishOp = buildOperation({ id: 'op-p', commandType: 'VOUCHER_TERMS_PUBLISH', payload: { voucherId: 'v-1' } });
  const grantOp = buildOperation({
    id: 'op-g',
    commandType: 'VOUCHER_GRANT',
    payload: { voucherOwnershipId: 'own-1', organizationEndUserId: 'member-1' },
  });
  const signed = { digest: 'DIGEST-V', expirationEpoch: 7n };
  const voucher = buildVoucher({ pointsCost: 25, expiresAt: new Date(5000), startsAt: null });
  const termsPublished = fakeChainResult({
    events: [{ type: 'pkg::voucher_terms::VoucherTermsPublished', parsedJson: { terms_id: '0xterms' } }],
  });

  function ops() {
    return {
      recordSubmitDigest: vi.fn(async () => {}),
      markSubmitted: vi.fn(async () => {}),
      markFailed: vi.fn(async () => {}),
      markUnknown: vi.fn(async () => true),
    };
  }

  it('publishes the promise and records the frozen object', async () => {
    const operations = ops();
    const signPublishVoucherTerms = vi.fn(async () => signed);
    const markVoucherPublished = vi.fn(async () => {});
    await processor(operations, {}, { signPublishVoucherTerms, execute: async () => termsPublished }, PROGRAMS_REPO, {
      findVoucherById: async () => voucher,
      markVoucherPublished,
    }).process(publishOp);
    expect(signPublishVoucherTerms).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ voucherId: 'v-1', pointsCost: 25, startsAtMs: 0, expiresAtMs: 5000 }),
    );
    expect(operations.recordSubmitDigest).toHaveBeenCalledWith('op-p', 'DIGEST-V', 7n);
    expect(markVoucherPublished).toHaveBeenCalledWith('v-1', '0xterms');
    expect(operations.markSubmitted).toHaveBeenCalled();
  });

  it('a failure before sending is definitive', async () => {
    const operations = ops();
    const failVoucherPublish = vi.fn(async () => {});
    await processor(operations, {}, {}, PROGRAMS_REPO, {
      findVoucherById: async () => undefined,
      failVoucherPublish,
    }).process(publishOp);
    expect(failVoucherPublish).toHaveBeenCalledWith('v-1');
    expect(operations.markFailed).toHaveBeenCalledWith('op-p', expect.stringMatching(/no longer exists/));
  });

  it('a failure verdict is definitive, and a lost answer is left for reconciliation', async () => {
    const operations = ops();
    const failVoucherPublish = vi.fn(async () => {});
    const rewards = { findVoucherById: async () => voucher, failVoucherPublish };
    await processor(
      operations,
      {},
      {
        signPublishVoucherTerms: async () => signed,
        execute: async () => fakeChainResult({ status: 'failure', errorMessage: 'aborted' }),
      },
      PROGRAMS_REPO,
      rewards,
    ).process(publishOp);
    expect(operations.markFailed).toHaveBeenCalledWith('op-p', 'aborted');
    expect(failVoucherPublish).toHaveBeenCalledTimes(1);

    const lost = ops();
    await processor(
      lost,
      {},
      {
        signPublishVoucherTerms: async () => signed,
        execute: async () => {
          throw new Error('connection dropped');
        },
      },
      PROGRAMS_REPO,
      rewards,
    ).process(publishOp);
    expect(lost.markUnknown).toHaveBeenCalledWith('op-p', expect.stringMatching(/outcome unknown/), undefined);
    expect(failVoucherPublish).toHaveBeenCalledTimes(1);
  });

  it('a landed publish that cannot be recorded stays unknown, with its digest', async () => {
    const operations = ops();
    await processor(
      operations,
      {},
      { signPublishVoucherTerms: async () => signed, execute: async () => fakeChainResult({ digest: 'LANDED' }) },
      PROGRAMS_REPO,
      { findVoucherById: async () => voucher },
    ).process(publishOp);
    expect(operations.markUnknown).toHaveBeenCalledWith(
      'op-p',
      expect.stringMatching(/VoucherTermsPublished/),
      'LANDED',
    );
  });

  it('grants through an existing account', async () => {
    const operations = ops();
    const signGrantVoucher = vi.fn(async () => signed);
    const confirmVoucherGrant = vi.fn(async () => ({ key: null }));
    const openAccount = vi.fn();
    await processor(
      operations,
      { getOrCreateCreditOwnership: existingAccount },
      { signGrantVoucher, openAccount, execute: async () => fakeChainResult({ digest: 'DIGEST-V' }) },
      PROGRAMS_REPO,
      { findOwnershipWithVoucher: async () => ({ voucher }), confirmVoucherGrant },
    ).process(grantOp);
    expect(openAccount).not.toHaveBeenCalled();
    expect(signGrantVoucher).toHaveBeenCalledWith(expect.anything(), {
      accountId: '0xexisting',
      termsId: '0xterms',
      reference: 'voucher-claim-own-1',
    });
    expect(confirmVoucherGrant).toHaveBeenCalledWith({ voucherOwnershipId: 'own-1', digest: 'DIGEST-V' });
  });

  it('opens an account first for a member who never earned', async () => {
    const setSuiCreditAccountId = vi.fn(async () => {});
    const signGrantVoucher = vi.fn(async () => signed);
    await processor(
      ops(),
      {
        getOrCreateCreditOwnership: async () => ({ id: 'ownership-1', suiCreditAccountId: null }),
        findBeneficiaryAddress: async () => '0xmember',
        setSuiCreditAccountId,
      },
      {
        signGrantVoucher,
        openAccount: async () =>
          fakeChainResult({
            events: [{ type: 'pkg::credit_account::CreditAccountOpened', parsedJson: { account_id: '0xnew' } }],
          }),
        execute: async () => fakeChainResult(),
      },
      PROGRAMS_REPO,
      { findOwnershipWithVoucher: async () => ({ voucher }), confirmVoucherGrant: async () => ({ key: null }) },
    ).process(grantOp);
    expect(setSuiCreditAccountId).toHaveBeenCalledWith('ownership-1', '0xnew');
    expect(signGrantVoucher).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: '0xnew' }));
  });

  it('cancels the voucher on-chain when refunding an unused one, and reverses the debit otherwise', async () => {
    const reversal = (voucherAction?: 'CANCEL') =>
      buildOperation({
        commandType: 'CREDIT_REVERSAL_CHAIN_SUBMIT',
        payload: {
          reversalTransactionId: 'rev-1',
          reversedTransactionType: 'REDEEM',
          organizationEndUserId: 'member-1',
          chainKey: 'voucher-claim-own-1',
          ...(voucherAction ? { voucherAction } : {}),
        },
      });
    const signCancelVoucher = vi.fn(async () => signed);
    const signReverseRedeem = vi.fn(async () => signed);
    const run = (operation: ReturnType<typeof reversal>) =>
      processor(
        ops(),
        { getCreditOwnershipByEndUserId: existingAccount, recordReversalOnChain: async () => ({ id: 'btx' }) },
        { signCancelVoucher, signReverseRedeem, execute: async () => fakeChainResult() },
      ).process(operation);

    await run(reversal('CANCEL'));
    expect(signCancelVoucher).toHaveBeenCalledWith(expect.anything(), {
      accountId: '0xexisting',
      reference: 'voucher-claim-own-1',
    });
    expect(signReverseRedeem).not.toHaveBeenCalled();

    await run(reversal());
    expect(signReverseRedeem).toHaveBeenCalledTimes(1);
  });
});
