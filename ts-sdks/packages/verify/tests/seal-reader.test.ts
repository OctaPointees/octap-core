import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectError } from '@mysten/sui/client';

const getObject = vi.fn();
vi.mock('@mysten/sui/grpc', () => ({
  SuiGrpcClient: class {
    core = { getObject };
  },
}));

const { AUDIT_NETWORKS, auditNetwork, encodeSealForTesting, suiSealReader, suiscanTransactionUrl } =
  await import('../src/index.js');

const PKG = AUDIT_NETWORKS.testnet!.packageId;
const SEAL = '0x' + '77'.repeat(32);
const content = encodeSealForTesting({
  sealObjectId: SEAL,
  organizationId: 'org',
  periodStartMs: 0,
  periodEndMs: 1,
  manifestHash: 'cd'.repeat(32),
  previousManifestHash: null,
  sealedAtMs: 5,
});
const object = (overrides: Record<string, unknown> = {}) => ({
  object: {
    type: `${PKG}::evidence_seal::EvidenceSeal`,
    owner: { $kind: 'Immutable' },
    content,
    previousTransaction: 'TX',
    ...overrides,
  },
});

describe('suiSealReader', () => {
  beforeEach(() => getObject.mockReset());

  it('reads a frozen seal of the trusted package', async () => {
    getObject.mockResolvedValue(object());
    await expect(suiSealReader('testnet').readSeal(SEAL)).resolves.toMatchObject({
      sealObjectId: SEAL,
      organizationId: 'org',
      manifestHash: 'cd'.repeat(32),
      transactionDigest: 'TX',
    });
  });

  it('refuses an object of another package or one that is not frozen', async () => {
    getObject.mockResolvedValue(object({ type: `0x${'99'.repeat(32)}::evidence_seal::EvidenceSeal` }));
    await expect(suiSealReader('testnet').readSeal(SEAL)).resolves.toBeNull();
    getObject.mockResolvedValue(object({ owner: { $kind: 'AddressOwner', AddressOwner: '0x1' } }));
    await expect(suiSealReader('testnet').readSeal(SEAL)).resolves.toBeNull();
  });

  it('answers null for a missing object and rethrows anything else', async () => {
    getObject.mockRejectedValueOnce(new ObjectError('notExists', 'gone', { reason: 'notFound' }));
    await expect(suiSealReader('testnet').readSeal(SEAL)).resolves.toBeNull();
    getObject.mockRejectedValueOnce(new Error('rpc down'));
    await expect(suiSealReader('testnet').readSeal(SEAL)).rejects.toThrow('rpc down');
  });

  it('only knows networks the package is published on', () => {
    expect(auditNetwork('testnet').packageId).toBe(PKG);
    expect(() => auditNetwork('mainnet')).toThrow(/No octap_audit package is published on Sui network "mainnet"/);
    expect(() => suiSealReader('devnet')).toThrow(/devnet/);
    expect(suiscanTransactionUrl('testnet', 'TX')).toBe('https://suiscan.xyz/testnet/tx/TX');
  });
});
