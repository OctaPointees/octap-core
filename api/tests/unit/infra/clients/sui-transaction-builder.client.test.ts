import { describe, expect, it, vi } from 'vitest';
import { TESTNET_OCTAP_PACKAGE_CONFIG, type OctapChainClient } from '@octap/chain';
import {
  ChainHistoryPrunedError,
  SuiTransactionBuilderClient,
} from '#infra/clients/sui/sui-transaction-builder.client.js';
import { configForNetwork } from '#infra/clients/sui/network-config.js';
import { requireEnv } from '#infra/clients/require-env.js';

function withChainClient(
  builder: SuiTransactionBuilderClient,
  client: Partial<Record<keyof OctapChainClient, unknown>>,
) {
  (builder as unknown as { chainClient: unknown }).chainClient = client;
  return builder;
}

describe('SuiTransactionBuilderClient', () => {
  it('exposes the one Move call its redeem builder produces', () => {
    expect(new SuiTransactionBuilderClient().redeemMoveCallTarget).toBe(
      `${TESTNET_OCTAP_PACKAGE_CONFIG.packageId}::credit_account::redeem`,
    );
  });

  it('refuses to construct for a network with no package', () => {
    vi.stubEnv('SUI_NETWORK', 'devnet');
    expect(() => new SuiTransactionBuilderClient()).toThrow(/no package configured for network "devnet"/);
    vi.stubEnv('SUI_NETWORK', 'mainnet');
    expect(() => new SuiTransactionBuilderClient()).toThrow(/"mainnet"/);
  });

  it('buildRedeemTransactionKind builds kind-only bytes (no sender, no gas)', async () => {
    const build = vi.fn(async () => new Uint8Array([7]));
    const rpc = { tag: 'rpc' };
    const buildRedeemTransaction = vi.fn(() => ({ build }));
    const builder = withChainClient(new SuiTransactionBuilderClient(), { buildRedeemTransaction, rpc });
    const params = { accountId: '0xacc', cost: 5n, reference: new Uint8Array([1]) };

    expect(await builder.buildRedeemTransactionKind(params)).toEqual(new Uint8Array([7]));
    expect(buildRedeemTransaction).toHaveBeenCalledWith(params);
    expect(build).toHaveBeenCalledWith({ client: rpc, onlyTransactionKind: true });
  });

  it('waitForTransaction and listCreditAccountEvents pass through to the chain client', async () => {
    const waitForTransaction = vi.fn(async () => ({ digest: 'D', status: 'success', events: [] }));
    const listCreditAccountEvents = vi.fn(async () => ({
      events: [],
      hasNextPage: false,
      startCursor: null,
      endCursor: null,
    }));
    const builder = withChainClient(new SuiTransactionBuilderClient(), { waitForTransaction, listCreditAccountEvents });

    expect((await builder.waitForTransaction('D')).digest).toBe('D');
    expect(waitForTransaction).toHaveBeenCalledWith('D');
    await builder.listCreditAccountEvents({ after: 'C1', limit: 5 });
    expect(listCreditAccountEvents).toHaveBeenCalledWith({ after: 'C1', limit: 5 });
  });

  it('builds the real chain client lazily, once', () => {
    const builder = new SuiTransactionBuilderClient();
    const client = (builder as unknown as { client: OctapChainClient }).client;
    expect((builder as unknown as { client: OctapChainClient }).client).toBe(client);
  });
});

describe('configForNetwork', () => {
  it('picks testnet, picks mainnet once deployed, and throws otherwise', () => {
    expect(configForNetwork('testnet', { testnet: 't', mainnet: undefined }, 'thing')).toBe('t');
    expect(configForNetwork('mainnet', { testnet: 't', mainnet: 'm' }, 'thing')).toBe('m');
    expect(() => configForNetwork('mainnet', { testnet: 't', mainnet: undefined }, 'thing')).toThrow(
      /No thing configured for Sui network "mainnet"/,
    );
    expect(() => configForNetwork('devnet', { testnet: 't', mainnet: 'm' }, 'thing')).toThrow(/"devnet"/);
  });
});

describe('requireEnv', () => {
  it('returns a set variable and names the adapter when one is missing', () => {
    vi.stubEnv('OCTAP_TEST_VAR', 'value');
    expect(requireEnv('OCTAP_TEST_VAR', 'test adapter')).toBe('value');
    vi.stubEnv('OCTAP_TEST_VAR', '');
    expect(() => requireEnv('OCTAP_TEST_VAR', 'test adapter')).toThrow(
      'Missing required env var OCTAP_TEST_VAR for the test adapter',
    );
  });

  it('findTransaction and currentEpoch are read-only pass-throughs (OCT-52)', async () => {
    const outcome = { digest: 'D1', status: 'success', events: [] };
    const findTransaction = vi.fn(async () => outcome);
    const currentEpoch = vi.fn(async () => 1261n);
    const builder = withChainClient(new SuiTransactionBuilderClient(), { findTransaction, currentEpoch });

    await expect(builder.findTransaction('D1')).resolves.toBe(outcome);
    await expect(builder.currentEpoch()).resolves.toBe(1261n);
    expect(findTransaction).toHaveBeenCalledWith('D1');
  });

  it('turns the node’s OUT_OF_RANGE pruned-history error into ChainHistoryPrunedError, with its lower bound', async () => {
    // The shape @mysten/sui's gRPC client throws, as seen live on testnet.
    const rpcError = Object.assign(
      new Error('requested data below earliest available; lowest available checkpoint is 404332001'),
      { name: 'RpcError', code: 'OUT_OF_RANGE' },
    );
    const builder = withChainClient(new SuiTransactionBuilderClient(), {
      listCreditAccountEvents: async () => {
        throw rpcError;
      },
    });

    const err = await builder.listCreditAccountEvents({ after: 'C1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainHistoryPrunedError);
    expect((err as ChainHistoryPrunedError).lowestAvailableCheckpoint).toBe(404332001n);
  });

  it('passes any other chain error through unchanged', async () => {
    const other = Object.assign(new Error('requested data below earliest available'), { code: 'UNAVAILABLE' });
    const builder = withChainClient(new SuiTransactionBuilderClient(), {
      listCreditAccountEvents: async () => {
        throw other;
      },
    });

    await expect(builder.listCreditAccountEvents({})).rejects.toBe(other);
  });

  it('latestCheckpoint reads the node’s checkpoint height', async () => {
    const getServiceInfo = vi.fn(async () => ({ response: { checkpointHeight: 406404430n } }));
    const builder = withChainClient(new SuiTransactionBuilderClient(), { rpc: { ledgerService: { getServiceInfo } } });

    await expect(builder.latestCheckpoint()).resolves.toBe(406404430n);
  });
});
