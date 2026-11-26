import { describe, expect, it, vi } from 'vitest';
import { bcs } from '@mysten/sui/bcs';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { TESTNET_OCTAP_AUDIT_CONFIG, buildSealEvidenceTransaction, latestEvidenceSealId } from '../src/index.js';

const ORG = '0b6c2f1e-1111-4222-8333-444455556666';
const HASH = 'ab'.repeat(32);

describe('buildSealEvidenceTransaction', () => {
  it('calls evidence_seal::seal with the cap, the registry, the clock and the period', () => {
    const tx = buildSealEvidenceTransaction(TESTNET_OCTAP_AUDIT_CONFIG, {
      organizationId: ORG,
      periodStartMs: 1000,
      periodEndMs: 2000,
      manifestHash: HASH,
      previousManifestHash: null,
    });
    const data = tx.getData();
    const call = data.commands.find((c) => c.$kind === 'MoveCall')!.MoveCall!;
    expect(`${call.package}::${call.module}::${call.function}`).toBe(
      `${TESTNET_OCTAP_AUDIT_CONFIG.packageId}::evidence_seal::seal`,
    );
    expect(call.arguments).toHaveLength(8);
    const objects = JSON.stringify(data.inputs.filter((i) => i.$kind !== 'Pure'));
    expect(objects).toContain(TESTNET_OCTAP_AUDIT_CONFIG.sealerCapId);
    expect(objects).toContain(TESTNET_OCTAP_AUDIT_CONFIG.registryId);
    expect(objects).toContain(normalizeSuiAddress('0x6'));
    const pure = data.inputs.filter((i) => i.$kind === 'Pure').map((i) => i.Pure!.bytes);
    const bytes = (b64: string) => Array.from(Buffer.from(b64, 'base64'));
    expect(bcs.vector(bcs.u8()).parse(Uint8Array.from(bytes(pure[0])))).toEqual(Array.from(Buffer.from(ORG)));
    expect(bcs.vector(bcs.u8()).parse(Uint8Array.from(bytes(pure[3])))).toEqual(Array.from(Buffer.from(HASH, 'hex')));
    expect(bcs.vector(bcs.u8()).parse(Uint8Array.from(bytes(pure[4])))).toEqual([]);
  });

  it('refuses a hash that is not a sha256 hex digest', () => {
    expect(() =>
      buildSealEvidenceTransaction(TESTNET_OCTAP_AUDIT_CONFIG, {
        organizationId: ORG,
        periodStartMs: 1,
        periodEndMs: 2,
        manifestHash: 'nothex',
        previousManifestHash: null,
      }),
    ).toThrow(/Not a sha256 hex digest/);
  });
});

describe('latestEvidenceSealId', () => {
  const answer = (value: Uint8Array | undefined, kind = 'Transaction') =>
    ({
      core: {
        simulateTransaction: vi.fn(async () => ({
          $kind: kind,
          commandResults: [{ returnValues: value ? [{ bcs: value }] : [] }],
        })),
      },
    }) as unknown as SuiGrpcClient;

  it('reads the organization’s latest seal from the registry, or null before its first', async () => {
    const id = '0x' + '12'.repeat(32);
    await expect(
      latestEvidenceSealId(answer(bcs.option(bcs.Address).serialize(id).toBytes()), TESTNET_OCTAP_AUDIT_CONFIG, ORG),
    ).resolves.toBe(id);
    await expect(
      latestEvidenceSealId(answer(bcs.option(bcs.Address).serialize(null).toBytes()), TESTNET_OCTAP_AUDIT_CONFIG, ORG),
    ).resolves.toBeNull();
  });

  it('throws when the registry cannot be read', async () => {
    await expect(latestEvidenceSealId(answer(undefined), TESTNET_OCTAP_AUDIT_CONFIG, ORG)).rejects.toThrow(
      /could not be read/,
    );
    await expect(
      latestEvidenceSealId(answer(new Uint8Array([0]), 'FailedTransaction'), TESTNET_OCTAP_AUDIT_CONFIG, ORG),
    ).rejects.toThrow(/could not be read/);
  });
});
