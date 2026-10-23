import { describe, expect, it, vi } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { TESTNET_OCTAP_DEMO_PROGRAM_CONFIG, operationShardIndex, type OctapChainClient } from '@octap/chain';
import { SuiClientService, selectShards } from '../../../../src/infra/clients/sui/sui.client.js';

/** Swaps the lazily-built chain client for a double; the adapter never touches the network. */
function withChainClient(service: SuiClientService, client: Partial<Record<keyof OctapChainClient, unknown>>) {
  (service as unknown as { chainClient: unknown }).chainClient = client;
  return service;
}

const fakeTx = () => ({ setGasBudget: vi.fn() });
const submitted = (events: Array<{ type: string; parsedJson: unknown }> = []) => ({ digest: 'D1', status: 'success' as const, events });

// Same key/count -> index fixtures as `shard_index_matches_shared_fixture` and
// `budget_shards_are_debited_independently` in contracts/sui/tests/credit_account_tests.move:
// if either side's routing changes, one of the two suites breaks.
const SHARD_INDEX_FIXTURES: Array<[string, number, number]> = [
  ['earn:fixture-shard-key', 7, 4],
  ['op-1', 16, 5],
  ['op-5', 1, 0],
  ['op-1', 2, 1],
  ['op-4', 2, 0],
];

describe('operationShardIndex', () => {
  it('matches the Move side on shared fixtures', () => {
    for (const [key, shardCount, expected] of SHARD_INDEX_FIXTURES) {
      expect(operationShardIndex(Buffer.from(key), shardCount), `${key} mod ${shardCount}`).toBe(expected);
    }
  });

  it.each([0, -1, 1.5])('rejects a non-positive-integer shard count (%d)', (count) => {
    expect(() => operationShardIndex(Buffer.from('op-1'), count)).toThrow(/positive integer/);
  });
});

describe('selectShards', () => {
  const config = { operationShardIds: ['0xop0', '0xop1'], budgetShardIds: ['0xbudget0', '0xbudget1'] };

  it('picks the operation and budget shard at the key-owned index', () => {
    expect(selectShards(config, Buffer.from('op-1'))).toEqual({ operationShardId: '0xop1', budgetShardId: '0xbudget1' });
    expect(selectShards(config, Buffer.from('op-4'))).toEqual({ operationShardId: '0xop0', budgetShardId: '0xbudget0' });
  });

  it('rejects a program with no shards or mismatched shard counts', () => {
    const key = Buffer.from('op-1');
    expect(() => selectShards({ operationShardIds: [], budgetShardIds: [] }, key)).toThrow(/same non-zero count/);
    expect(() => selectShards({ operationShardIds: ['0xop0'], budgetShardIds: ['0xb0', '0xb1'] }, key)).toThrow(/same non-zero count/);
  });
});

describe('SuiClientService', () => {
  it('refuses to construct for a network with no demo program', () => {
    vi.stubEnv('SUI_NETWORK', 'mainnet');
    expect(() => new SuiClientService()).toThrow(/No demo program configured for Sui network "mainnet"/);
  });

  it('issuerAddress derives from SUI_ISSUER_PRIVATE_KEY, and fails loudly without it', () => {
    vi.stubEnv('SUI_ISSUER_PRIVATE_KEY', '');
    expect(() => new SuiClientService().issuerAddress()).toThrow(/Missing required env var SUI_ISSUER_PRIVATE_KEY for the Sui chain adapter/);

    const keypair = Ed25519Keypair.generate();
    vi.stubEnv('SUI_ISSUER_PRIVATE_KEY', keypair.getSecretKey());
    const service = new SuiClientService();
    expect(service.issuerAddress()).toBe(keypair.getPublicKey().toSuiAddress());
    expect(service.issuerAddress()).toBe(keypair.getPublicKey().toSuiAddress());
  });

  it('openAccount opens under the demo program and exposes eventField on the result', async () => {
    vi.stubEnv('SUI_ISSUER_PRIVATE_KEY', Ed25519Keypair.generate().getSecretKey());
    const tx = fakeTx();
    const buildOpenAccountTransaction = vi.fn(() => tx);
    const signAndExecute = vi.fn(async () =>
      submitted([{ type: '0xpkg::credit_account::CreditAccountOpened', parsedJson: { account_id: '0xacc' } }]),
    );
    const service = withChainClient(new SuiClientService(), { buildOpenAccountTransaction, signAndExecute });

    const result = await service.openAccount('0xbeneficiary');

    expect(buildOpenAccountTransaction).toHaveBeenCalledWith({
      issuerCapId: TESTNET_OCTAP_DEMO_PROGRAM_CONFIG.issuerCapId,
      programId: TESTNET_OCTAP_DEMO_PROGRAM_CONFIG.programControlId,
      beneficiary: '0xbeneficiary',
    });
    expect(tx.setGasBudget).toHaveBeenCalledWith(50_000_000);
    expect(signAndExecute).toHaveBeenCalledWith(tx, expect.anything());
    expect(result.eventField('CreditAccountOpened', 'account_id')).toBe('0xacc');
    expect(result.eventField('Nope', 'account_id')).toBeUndefined();
  });

  it('earn routes to the key-owned shard pair and encodes the operation key', async () => {
    vi.stubEnv('SUI_ISSUER_PRIVATE_KEY', Ed25519Keypair.generate().getSecretKey());
    const buildEarnTransaction = vi.fn(() => fakeTx());
    const service = withChainClient(new SuiClientService(), { buildEarnTransaction, signAndExecute: async () => submitted() });

    await service.earn({ accountId: '0xacc', purchaseAmount: 10_000, operationKey: 'idem-1' });

    expect(buildEarnTransaction).toHaveBeenCalledWith({
      issuerCapId: TESTNET_OCTAP_DEMO_PROGRAM_CONFIG.issuerCapId,
      programId: TESTNET_OCTAP_DEMO_PROGRAM_CONFIG.programControlId,
      policyId: TESTNET_OCTAP_DEMO_PROGRAM_CONFIG.policyVersionId,
      accountId: '0xacc',
      operationShardId: TESTNET_OCTAP_DEMO_PROGRAM_CONFIG.operationShardIds[0],
      budgetShardId: TESTNET_OCTAP_DEMO_PROGRAM_CONFIG.budgetShardIds[0],
      purchaseAmount: 10_000,
      operationKey: new TextEncoder().encode('idem-1'),
    });
  });

  it('builds a real OctapChainClient lazily, once', () => {
    const service = new SuiClientService();
    const client = (service as unknown as { client: OctapChainClient }).client;
    expect(client).toBeDefined();
    expect((service as unknown as { client: OctapChainClient }).client).toBe(client);
  });
});
