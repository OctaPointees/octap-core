import { describe, expect, it, vi } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { toBase64 } from '@mysten/sui/utils';
import { EnokiClient } from '../../../../src/infra/clients/enoki/enoki.client.js';

/** Swaps the lazily-built Mysten SDK client for a double. */
function withSdk(sdk: Record<string, unknown>) {
  const enoki = new EnokiClient();
  (enoki as unknown as { client: unknown }).client = sdk;
  return enoki;
}

const ephemeralPublicKey = () => Ed25519Keypair.generate().getPublicKey();

describe('EnokiClient', () => {
  it('sponsorship calls default to the deployment network, not Enoki’s mainnet default', async () => {
    vi.stubEnv('SUI_NETWORK', 'testnet');
    const createSponsoredTransaction = vi.fn(async () => ({ bytes: 'b', digest: 'd' }));
    const enoki = withSdk({ createSponsoredTransaction });

    await enoki.createSponsoredTransaction({
      transactionKindBytes: new Uint8Array([1]),
      sender: '0xsender',
      allowedMoveCallTargets: ['t'],
    });
    await enoki.createSponsoredTransaction({
      network: 'devnet',
      transactionKindBytes: new Uint8Array([1]),
      sender: '0xsender',
      allowedMoveCallTargets: [],
    });

    expect(createSponsoredTransaction).toHaveBeenNthCalledWith(1, {
      network: 'testnet',
      transactionKindBytes: toBase64(new Uint8Array([1])),
      sender: '0xsender',
      allowedAddresses: ['0xsender'],
      allowedMoveCallTargets: ['t'],
    });
    expect(createSponsoredTransaction).toHaveBeenNthCalledWith(2, expect.objectContaining({ network: 'devnet' }));
  });

  it('falls back to testnet when SUI_NETWORK is unset', async () => {
    vi.stubEnv('SUI_NETWORK', undefined);
    const createSponsoredTransaction = vi.fn(async () => ({ bytes: 'b', digest: 'd' }));

    await withSdk({ createSponsoredTransaction }).createSponsoredTransaction({
      transactionKindBytes: new Uint8Array(),
      sender: '0xs',
      allowedMoveCallTargets: [],
    });

    expect(createSponsoredTransaction).toHaveBeenCalledWith(expect.objectContaining({ network: 'testnet' }));
  });

  it('zkLogin nonce and proof decode the Sui-flagged ephemeral key and default the network', async () => {
    vi.stubEnv('SUI_NETWORK', 'testnet');
    const key = ephemeralPublicKey();
    const createZkLoginNonce = vi.fn<(params: unknown) => Promise<{ nonce: string }>>(async () => ({ nonce: 'n' }));
    const createZkLoginZkp = vi.fn(async () => ({ proofPoints: {} }));
    const enoki = withSdk({ createZkLoginNonce, createZkLoginZkp });

    await enoki.createZkLoginNonce({ ephemeralPublicKey: key.toSuiPublicKey(), additionalEpochs: 2 });
    await enoki.createZkLoginProof({
      network: 'devnet',
      jwt: 'jwt',
      ephemeralPublicKey: key.toSuiPublicKey(),
      randomness: 'r',
      maxEpoch: 9,
    });

    const nonceArgs = createZkLoginNonce.mock.calls[0][0] as unknown as {
      network: string;
      ephemeralPublicKey: { toSuiAddress(): string };
      additionalEpochs: number;
    };
    expect(nonceArgs.network).toBe('testnet');
    expect(nonceArgs.additionalEpochs).toBe(2);
    expect(nonceArgs.ephemeralPublicKey.toSuiAddress()).toBe(key.toSuiAddress());
    expect(createZkLoginZkp).toHaveBeenCalledWith(
      expect.objectContaining({ network: 'devnet', jwt: 'jwt', randomness: 'r', maxEpoch: 9 }),
    );

    await enoki.createZkLoginProof({
      jwt: 'jwt',
      ephemeralPublicKey: key.toSuiPublicKey(),
      randomness: 'r',
      maxEpoch: 9,
    });
    expect(createZkLoginZkp).toHaveBeenLastCalledWith(expect.objectContaining({ network: 'testnet' }));

    await enoki.createZkLoginNonce({ network: 'devnet', ephemeralPublicKey: key.toSuiPublicKey() });
    expect(createZkLoginNonce).toHaveBeenLastCalledWith(expect.objectContaining({ network: 'devnet' }));
  });

  it('address resolution and sponsored execution pass straight through', async () => {
    const getZkLogin = vi.fn(async () => ({ address: '0xabc', publicKey: 'pk', salt: 's' }));
    const executeSponsoredTransaction = vi.fn(async () => ({ digest: 'd' }));
    const enoki = withSdk({ getZkLogin, executeSponsoredTransaction });

    expect(await enoki.resolveZkLoginAddress('jwt')).toEqual({ address: '0xabc', publicKey: 'pk', salt: 's' });
    expect(getZkLogin).toHaveBeenCalledWith({ jwt: 'jwt' });
    expect(await enoki.executeSponsoredTransaction({ digest: 'd', signature: 'sig' })).toEqual({ digest: 'd' });
  });

  it('builds the SDK lazily from ENOKI_API_KEY, and names the variable when it is missing', async () => {
    vi.stubEnv('ENOKI_API_KEY', '');
    await expect(new EnokiClient().resolveZkLoginAddress('jwt')).rejects.toThrow(
      /Missing required env var ENOKI_API_KEY for the Enoki adapter/,
    );

    vi.stubEnv('ENOKI_API_KEY', 'enoki_public_test');
    const enoki = new EnokiClient();
    const sdk = (enoki as unknown as { sdk: unknown }).sdk;
    expect(sdk).toBeDefined();
    expect((enoki as unknown as { sdk: unknown }).sdk).toBe(sdk);
  });
});
