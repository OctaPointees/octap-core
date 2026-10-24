import { describe, expect, it, vi } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import { TransactionError } from '@mysten/sui/client';
import { verifyTransactionSignature } from '@mysten/sui/verify';
import {
  OctapChainClient,
  TESTNET_OCTAP_PACKAGE_CONFIG,
  eventField,
  operationShardIndex,
  signerFromPrivateKey,
  transactionExpirationEpoch,
} from '../src/index.js';

const PKG = '0x' + 'ab'.repeat(32);
const ID = (n: number) => '0x' + n.toString(16).padStart(64, '0');

/** `package::module::function` of every MoveCall in a built-but-unsigned transaction. */
function moveCalls(tx: Transaction): string[] {
  return tx
    .getData()
    .commands.filter((c) => c.$kind === 'MoveCall')
    .map((c) => `${c.MoveCall!.package}::${c.MoveCall!.module}::${c.MoveCall!.function}`);
}

const client = () => new OctapChainClient({ package: { packageId: PKG } });

describe('OctapChainClient transaction builders', () => {
  it('defaults to the testnet package', () => {
    const tx = new OctapChainClient().buildRedeemTransaction({
      accountId: ID(1),
      cost: 1,
      reference: new Uint8Array(),
    });
    expect(moveCalls(tx)[0].startsWith(TESTNET_OCTAP_PACKAGE_CONFIG.packageId)).toBe(true);
  });

  it('builds one Move call per single-purpose transaction', () => {
    const c = client();
    expect(
      moveCalls(c.buildOpenAccountTransaction({ issuerCapId: ID(1), programId: ID(2), beneficiary: ID(3) })),
    ).toEqual([`${PKG}::credit_account::open_account`]);
    expect(
      moveCalls(
        c.buildEarnTransaction({
          issuerCapId: ID(1),
          programId: ID(2),
          policyId: ID(3),
          accountId: ID(4),
          operationShardId: ID(5),
          budgetShardId: ID(6),
          purchaseAmount: 10_000,
          operationKey: new TextEncoder().encode('k'),
        }),
      ),
    ).toEqual([`${PKG}::credit_account::earn`]);
    expect(moveCalls(c.buildRedeemTransaction({ accountId: ID(1), cost: 5n, reference: new Uint8Array([1]) }))).toEqual(
      [`${PKG}::credit_account::redeem`],
    );
    expect(moveCalls(c.buildCreateProgramTransaction())).toEqual([`${PKG}::program_control::create_program_entry`]);
    expect(
      moveCalls(
        c.buildPublishPolicyTransaction({
          adminCapId: ID(1),
          programId: ID(2),
          version: 1,
          earnBps: 100,
          expiryMs: 1000,
        }),
      ),
    ).toEqual([`${PKG}::policy_version::publish`]);
    expect(
      moveCalls(
        c.buildCreateShardsTransaction({ adminCapId: ID(1), programId: ID(2), shardCount: 2, totalBudget: 10 }),
      ),
    ).toEqual([`${PKG}::operation_shard::create_shards`, `${PKG}::budget_shard::create_shards`]);
  });

  it('tops up each listed budget shard with its own top_up call', () => {
    expect(
      moveCalls(
        client().buildTopUpBudgetTransaction({
          adminCapId: ID(1),
          topUps: [
            { budgetShardId: ID(2), amount: 10 },
            { budgetShardId: ID(3), amount: 5n },
          ],
        }),
      ),
    ).toEqual([`${PKG}::budget_shard::top_up`, `${PKG}::budget_shard::top_up`]);
  });

  it('activate+issue_cap optionally creates shards in the same transaction', () => {
    const base = { adminCapId: ID(1), programId: ID(2), policyVersionId: ID(3), issuerRecipient: ID(4) };
    expect(moveCalls(client().buildActivatePolicyAndIssueCapTransaction(base))).toEqual([
      `${PKG}::program_control::activate_policy`,
      `${PKG}::program_control::issue_cap`,
    ]);
    expect(
      moveCalls(
        client().buildActivatePolicyAndIssueCapTransaction({ ...base, shards: { shardCount: 1, totalBudget: 5 } }),
      ),
    ).toEqual([
      `${PKG}::program_control::activate_policy`,
      `${PKG}::program_control::issue_cap`,
      `${PKG}::operation_shard::create_shards`,
      `${PKG}::budget_shard::create_shards`,
    ]);
  });
});

describe('OctapChainClient RPC wrappers', () => {
  const okTx = {
    digest: 'D1',
    status: { success: true },
    events: [{ eventType: `${PKG}::credit_account::CreditEarned`, json: { amount: '1' } }],
  };
  const failedTx = { digest: 'D2', status: { success: false, error: { message: 'MoveAbort 7' } }, events: undefined };

  it('signAndExecute signs first, then sends, waits for the checkpoint, and normalizes success and failure', async () => {
    const c = client();
    const signed = { bytes: new Uint8Array([1]), signature: 'sig', digest: 'D1', expirationEpoch: 7n };
    const sign = vi.spyOn(c, 'sign').mockResolvedValue(signed);
    const executeTransaction = vi
      .spyOn(c.rpc.core, 'executeTransaction')
      .mockResolvedValueOnce({ $kind: 'Transaction', Transaction: okTx } as never)
      .mockResolvedValueOnce({ $kind: 'FailedTransaction', FailedTransaction: failedTx } as never);
    const waitForTransaction = vi.spyOn(c.rpc.core, 'waitForTransaction').mockResolvedValue({} as never);
    const signer = Ed25519Keypair.generate();
    const tx = c.buildCreateProgramTransaction();

    expect(await c.signAndExecute(tx, signer)).toEqual({
      digest: 'D1',
      status: 'success',
      errorMessage: undefined,
      events: [{ type: `${PKG}::credit_account::CreditEarned`, parsedJson: { amount: '1' } }],
    });
    expect(sign).toHaveBeenCalledWith(tx, signer);
    expect(executeTransaction).toHaveBeenCalledWith({
      transaction: signed.bytes,
      signatures: ['sig'],
      include: { effects: true, events: true },
    });
    expect(waitForTransaction).toHaveBeenCalledWith({ digest: 'D1', include: { effects: true, events: true } });

    expect(await c.signAndExecute(tx, signer)).toEqual({
      digest: 'D2',
      status: 'failure',
      errorMessage: 'MoveAbort 7',
      events: [],
    });
  });

  it('waitForTransaction normalizes a transaction this process did not sign', async () => {
    const c = client();
    vi.spyOn(c.rpc.core, 'waitForTransaction')
      .mockResolvedValueOnce({ $kind: 'Transaction', Transaction: okTx } as never)
      .mockResolvedValueOnce({ $kind: 'FailedTransaction', FailedTransaction: failedTx } as never);

    expect((await c.waitForTransaction('D1')).status).toBe('success');
    expect(await c.waitForTransaction('D2')).toMatchObject({ status: 'failure', errorMessage: 'MoveAbort 7' });
  });

  it('listCreditAccountEvents filters by module and strips the event type prefix', async () => {
    const c = client();
    const listEvents = vi.spyOn(c.rpc.core, 'listEvents').mockResolvedValue({
      events: [
        {
          eventType: `${PKG}::credit_account::CreditEarned`,
          sender: '0xs',
          json: { amount: '1' },
          checkpoint: '9',
          transactionDigest: 'D',
          eventIndex: 2,
        },
        {
          eventType: 'Unqualified',
          sender: '0xs',
          json: null,
          checkpoint: null,
          transactionDigest: 'D',
          eventIndex: 3,
        },
      ],
      hasNextPage: true,
      startCursor: 'S',
      endCursor: 'E',
    } as never);

    const page = await c.listCreditAccountEvents({ after: null, limit: 5, order: 'descending' });

    expect(listEvents).toHaveBeenCalledWith({
      filter: { emitModule: `${PKG}::credit_account` },
      after: undefined,
      limit: 5,
      order: 'descending',
    });
    expect(page).toEqual({
      events: [
        {
          name: 'CreditEarned',
          sender: '0xs',
          json: { amount: '1' },
          checkpoint: '9',
          transactionDigest: 'D',
          eventIndex: 2,
        },
        { name: 'Unqualified', sender: '0xs', json: null, checkpoint: null, transactionDigest: 'D', eventIndex: 3 },
      ],
      hasNextPage: true,
      startCursor: 'S',
      endCursor: 'E',
    });
  });
});

describe('chain helpers', () => {
  it('eventField reads the first matching event’s field', () => {
    const result = {
      digest: 'D',
      status: 'success' as const,
      events: [
        { type: '0x1::m::Other', parsedJson: { id: 'x' } },
        { type: '0x1::m::ProgramCreated', parsedJson: { program_id: '0xp' } },
      ],
    };
    expect(eventField(result, 'ProgramCreated', 'program_id')).toBe('0xp');
    expect(eventField(result, 'ProgramCreated', 'missing')).toBeUndefined();
    expect(eventField(result, 'Absent', 'program_id')).toBeUndefined();
  });

  it('signerFromPrivateKey round-trips an ed25519 key and rejects other schemes', () => {
    const keypair = Ed25519Keypair.generate();
    expect(signerFromPrivateKey(keypair.getSecretKey()).toSuiAddress()).toBe(keypair.toSuiAddress());
    expect(() => signerFromPrivateKey(Secp256k1Keypair.generate().getSecretKey())).toThrow(
      /Unsupported key scheme "Secp256k1"/,
    );
  });

  it('operationShardIndex is sha256(key)[0..8] big-endian mod shardCount', () => {
    expect(operationShardIndex(new TextEncoder().encode('op-1'), 2)).toBe(1);
    expect(() => operationShardIndex(new Uint8Array(), 0)).toThrow(/positive integer/);
  });
});

/** Real, fully resolved transaction bytes (no network): fixed gas, one argument-less Move call. */
async function offlineBytes(
  expiration?: Parameters<Transaction['setExpiration']>[0],
): Promise<Uint8Array<ArrayBuffer>> {
  const tx = new Transaction();
  tx.setSender(ID(1));
  tx.setGasPrice(1000);
  tx.setGasBudget(10_000_000);
  tx.setGasPayment([{ objectId: ID(9), version: '1', digest: '11111111111111111111111111111111' }]);
  tx.moveCall({ target: '0x2::clock::timestamp_ms', arguments: [] });
  if (expiration) {
    tx.setExpiration(expiration);
  }
  return new Uint8Array(await tx.build());
}

describe('digest-first submission (OCT-52)', () => {
  it('transactionExpirationEpoch reads Epoch and ValidDuring, and null when the bytes never expire', async () => {
    expect(transactionExpirationEpoch(await offlineBytes())).toBeNull();
    expect(transactionExpirationEpoch(await offlineBytes({ Epoch: 5 }))).toBe(5n);
    const validDuring = {
      minEpoch: '4',
      maxEpoch: '5',
      minTimestamp: null,
      maxTimestamp: null,
      chain: '11111111111111111111111111111111',
      nonce: 1,
    };
    expect(transactionExpirationEpoch(await offlineBytes({ ValidDuring: validDuring }))).toBe(5n);
    expect(
      transactionExpirationEpoch(await offlineBytes({ ValidDuring: { ...validDuring, maxEpoch: null } })),
    ).toBeNull();
    expect(transactionExpirationEpoch(Buffer.from(await offlineBytes({ Epoch: 6 })).toString('base64'))).toBe(6n);
  });

  it('sign keeps an expiration the build already set (address-balance gas), and signs exactly those bytes', async () => {
    const c = client();
    const signer = Ed25519Keypair.generate();
    const bytes = await offlineBytes({ Epoch: 12 });
    const tx = c.buildCreateProgramTransaction();
    const build = vi.spyOn(tx, 'build').mockResolvedValue(bytes);
    const getCurrentSystemState = vi.spyOn(c.rpc.core, 'getCurrentSystemState');

    const signed = await c.sign(tx, signer);

    expect(build).toHaveBeenCalledOnce();
    expect(getCurrentSystemState).not.toHaveBeenCalled();
    expect(tx.getData().sender).toBe(signer.toSuiAddress());
    expect(signed).toMatchObject({
      bytes,
      digest: TransactionDataBuilder.getDigestFromBytes(bytes),
      expirationEpoch: 12n,
    });
    await expect(verifyTransactionSignature(bytes, signed.signature)).resolves.toBeDefined();
  });

  it('sign pins a never-expiring build to the current epoch and rebuilds', async () => {
    const c = client();
    const tx = c.buildCreateProgramTransaction();
    const pinned = await offlineBytes({ Epoch: 1261 });
    vi.spyOn(tx, 'build')
      .mockResolvedValueOnce(await offlineBytes())
      .mockResolvedValueOnce(pinned);
    vi.spyOn(c.rpc.core, 'getCurrentSystemState').mockResolvedValue({ systemState: { epoch: '1261' } } as never);
    const setExpiration = vi.spyOn(tx, 'setExpiration');

    const signed = await c.sign(tx, Ed25519Keypair.generate());

    expect(setExpiration).toHaveBeenCalledWith({ Epoch: '1261' });
    expect(signed).toMatchObject({ bytes: pinned, expirationEpoch: 1261n });
  });

  it('findTransaction normalizes a found digest, returns null for an unknown one, and rethrows anything else', async () => {
    const c = client();
    const boom = new Error('UNAVAILABLE');
    const found = { digest: 'D1', status: { success: true }, events: [] };
    vi.spyOn(c.rpc.core, 'getTransaction')
      .mockResolvedValueOnce({ $kind: 'Transaction', Transaction: found } as never)
      .mockRejectedValueOnce(new TransactionError('notFound', 'D404'))
      .mockRejectedValueOnce(boom);

    await expect(c.findTransaction('D1')).resolves.toMatchObject({ digest: 'D1', status: 'success' });
    await expect(c.findTransaction('D404')).resolves.toBeNull();
    await expect(c.findTransaction('D500')).rejects.toBe(boom);
  });

  it('currentEpoch reads the system state', async () => {
    const c = client();
    vi.spyOn(c.rpc.core, 'getCurrentSystemState').mockResolvedValue({ systemState: { epoch: '1261' } } as never);
    await expect(c.currentEpoch()).resolves.toBe(1261n);
  });
});
