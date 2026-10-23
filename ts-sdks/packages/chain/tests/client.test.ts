import { describe, expect, it, vi } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import type { Transaction } from '@mysten/sui/transactions';
import { OctapChainClient, TESTNET_OCTAP_PACKAGE_CONFIG, eventField, operationShardIndex, signerFromPrivateKey } from '../src/index.js';

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
    const tx = new OctapChainClient().buildRedeemTransaction({ accountId: ID(1), cost: 1, reference: new Uint8Array() });
    expect(moveCalls(tx)[0].startsWith(TESTNET_OCTAP_PACKAGE_CONFIG.packageId)).toBe(true);
  });

  it('builds one Move call per single-purpose transaction', () => {
    const c = client();
    expect(moveCalls(c.buildOpenAccountTransaction({ issuerCapId: ID(1), programId: ID(2), beneficiary: ID(3) }))).toEqual([
      `${PKG}::credit_account::open_account`,
    ]);
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
    expect(moveCalls(c.buildRedeemTransaction({ accountId: ID(1), cost: 5n, reference: new Uint8Array([1]) }))).toEqual([
      `${PKG}::credit_account::redeem`,
    ]);
    expect(moveCalls(c.buildCreateProgramTransaction())).toEqual([`${PKG}::program_control::create_program_entry`]);
    expect(
      moveCalls(c.buildPublishPolicyTransaction({ adminCapId: ID(1), programId: ID(2), version: 1, earnBps: 100, expiryMs: 1000 })),
    ).toEqual([`${PKG}::policy_version::publish`]);
    expect(moveCalls(c.buildCreateShardsTransaction({ adminCapId: ID(1), programId: ID(2), shardCount: 2, totalBudget: 10 }))).toEqual([
      `${PKG}::operation_shard::create_shards`,
      `${PKG}::budget_shard::create_shards`,
    ]);
  });

  it('activate+issue_cap optionally creates shards in the same transaction', () => {
    const base = { adminCapId: ID(1), programId: ID(2), policyVersionId: ID(3), issuerRecipient: ID(4) };
    expect(moveCalls(client().buildActivatePolicyAndIssueCapTransaction(base))).toEqual([
      `${PKG}::program_control::activate_policy`,
      `${PKG}::program_control::issue_cap`,
    ]);
    expect(moveCalls(client().buildActivatePolicyAndIssueCapTransaction({ ...base, shards: { shardCount: 1, totalBudget: 5 } }))).toEqual([
      `${PKG}::program_control::activate_policy`,
      `${PKG}::program_control::issue_cap`,
      `${PKG}::operation_shard::create_shards`,
      `${PKG}::budget_shard::create_shards`,
    ]);
  });
});

describe('OctapChainClient RPC wrappers', () => {
  const okTx = { digest: 'D1', status: { success: true }, events: [{ eventType: `${PKG}::credit_account::CreditEarned`, json: { amount: '1' } }] };
  const failedTx = { digest: 'D2', status: { success: false, error: { message: 'MoveAbort 7' } }, events: undefined };

  it('signAndExecute waits for the checkpoint and normalizes success and failure', async () => {
    const c = client();
    const signAndExecuteTransaction = vi
      .spyOn(c.rpc.core, 'signAndExecuteTransaction')
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
    expect(signAndExecuteTransaction).toHaveBeenCalledWith({ transaction: tx, signer, include: { effects: true, events: true } });
    expect(waitForTransaction).toHaveBeenCalledWith({ digest: 'D1', include: { effects: true, events: true } });

    expect(await c.signAndExecute(tx, signer)).toEqual({ digest: 'D2', status: 'failure', errorMessage: 'MoveAbort 7', events: [] });
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
        { eventType: `${PKG}::credit_account::CreditEarned`, sender: '0xs', json: { amount: '1' }, checkpoint: '9', transactionDigest: 'D', eventIndex: 2 },
        { eventType: 'Unqualified', sender: '0xs', json: null, checkpoint: null, transactionDigest: 'D', eventIndex: 3 },
      ],
      hasNextPage: true,
      startCursor: 'S',
      endCursor: 'E',
    } as never);

    const page = await c.listCreditAccountEvents({ after: null, limit: 5, order: 'descending' });

    expect(listEvents).toHaveBeenCalledWith({ filter: { emitModule: `${PKG}::credit_account` }, after: undefined, limit: 5, order: 'descending' });
    expect(page).toEqual({
      events: [
        { name: 'CreditEarned', sender: '0xs', json: { amount: '1' }, checkpoint: '9', transactionDigest: 'D', eventIndex: 2 },
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
    expect(() => signerFromPrivateKey(Secp256k1Keypair.generate().getSecretKey())).toThrow(/Unsupported key scheme "Secp256k1"/);
  });

  it('operationShardIndex is sha256(key)[0..8] big-endian mod shardCount', () => {
    expect(operationShardIndex(new TextEncoder().encode('op-1'), 2)).toBe(1);
    expect(() => operationShardIndex(new Uint8Array(), 0)).toThrow(/positive integer/);
  });
});
