import { describe, expect, it } from 'vitest';
import type { EvidenceBundle, EvidenceLedgerFact, EvidenceRecomputation } from '@octap/contracts';
import {
  BUNDLE_FORMAT,
  buildManifest,
  canonicalJson,
  encodeSealForTesting,
  manifestHash,
  parseSeal,
  sectionOf,
  sha256Hex,
  verifyBundle,
  verifyRecomputation,
  type OnChainSeal,
  type SealReader,
} from '../src/index.js';

const ORG = '0b6c2f1e-1111-4222-8333-444455556666';
const SEAL_ID = '0x' + 'ab'.repeat(32);
const START = '2026-11-25T00:00:00.000Z';
const END = '2026-11-26T00:00:00.000Z';

const earn: EvidenceLedgerFact = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'EARN',
  pointsAmount: 100,
  purchaseAmount: 10_000,
  memberId: '22222222-2222-4222-8222-222222222222',
  receiptReference: 'R-1',
  reversesTransactionId: null,
  digest: 'Dg1',
  confirmedAt: '2026-11-25T08:00:00.000Z',
};

function bundleAndSeal(previous: string | null = null): { bundle: EvidenceBundle; seal: OnChainSeal } {
  const manifest = buildManifest({
    organizationId: ORG,
    periodStart: START,
    periodEnd: END,
    ledger: [earn],
    audit: [],
    previousManifestHash: previous,
  });
  const hash = manifestHash(manifest);
  const seal: OnChainSeal = {
    sealObjectId: SEAL_ID,
    organizationId: ORG,
    periodStartMs: Date.parse(START),
    periodEndMs: Date.parse(END),
    manifestHash: hash,
    previousManifestHash: previous,
    sealedAtMs: Date.parse(END) + 600_000,
    transactionDigest: 'SealTx',
  };
  const bundle: EvidenceBundle = {
    format: BUNDLE_FORMAT,
    manifest,
    manifestHash: hash,
    seal: { network: 'testnet', packageId: '0x1', sealObjectId: SEAL_ID, transactionDigest: 'SealTx', sealedAt: '' },
    ledger: [earn],
    audit: [],
  };
  return { bundle, seal };
}

const readerOf = (seal: OnChainSeal | null): SealReader => ({ readSeal: async () => seal });

describe('canonicalJson', () => {
  it('sorts keys at every depth and leaves out undefined fields', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: null }], c: 'x' }, u: undefined })).toBe(
      '{"a":{"c":"x","d":[1,{"y":null,"z":1}]},"b":1}',
    );
  });

  it('refuses values JSON cannot carry exactly', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(/non-finite/);
    expect(() => canonicalJson(1n)).toThrow(/bigint/);
  });

  it('gives a section hash over one line per fact, and the empty hash for no facts', () => {
    expect(sectionOf([])).toEqual({ count: 0, sha256: sha256Hex('') });
    expect(sectionOf([earn]).sha256).toBe(sha256Hex(`${canonicalJson(earn)}\n`));
  });
});

describe('verifyBundle', () => {
  it('matches an untouched bundle', async () => {
    const { bundle, seal } = bundleAndSeal();
    await expect(verifyBundle(bundle, readerOf(seal))).resolves.toMatchObject({ result: 'MATCH', mismatched: [] });
  });

  it('names the ledger when a fact was edited after sealing', async () => {
    const { bundle, seal } = bundleAndSeal();
    bundle.ledger = [{ ...earn, pointsAmount: 1000 }];
    await expect(verifyBundle(bundle, readerOf(seal))).resolves.toMatchObject({
      result: 'MISMATCH',
      mismatched: ['ledger'],
    });
  });

  it('refuses a manifest rewritten to fit edited facts', async () => {
    const { bundle, seal } = bundleAndSeal();
    bundle.ledger = [];
    bundle.manifest = { ...bundle.manifest, ledger: sectionOf([]) };
    await expect(verifyBundle(bundle, readerOf(seal))).resolves.toMatchObject({
      result: 'MISMATCH',
      mismatched: ['manifest'],
    });
  });

  it('refuses a seal of another organization or period', async () => {
    const { bundle, seal } = bundleAndSeal();
    await expect(verifyBundle(bundle, readerOf({ ...seal, organizationId: 'other' }))).resolves.toMatchObject({
      result: 'MISMATCH',
      mismatched: ['manifest'],
      reasons: ['The seal belongs to another organization'],
    });
    await expect(verifyBundle(bundle, readerOf({ ...seal, periodEndMs: seal.periodEndMs + 1 }))).resolves.toMatchObject(
      { mismatched: ['manifest'] },
    );
  });

  it('refuses a seal that is not a genuine one', async () => {
    const { bundle } = bundleAndSeal();
    await expect(verifyBundle(bundle, readerOf(null))).resolves.toMatchObject({
      result: 'MISMATCH',
      mismatched: ['seal'],
    });
  });

  it('refuses a file that is not a bundle', async () => {
    await expect(verifyBundle({} as EvidenceBundle, readerOf(null))).rejects.toThrow(/Not an Octap evidence bundle/);
  });
});

describe('verifyRecomputation', () => {
  function recomputation(): { recomputation: EvidenceRecomputation; seal: OnChainSeal } {
    const { bundle, seal } = bundleAndSeal('c'.repeat(64));
    return {
      seal,
      recomputation: {
        periodId: 'p',
        sealedManifest: bundle.manifest,
        recomputedManifest: bundle.manifest,
        seal: bundle.seal,
        computedAt: '',
      },
    };
  }

  it('matches when the database still holds what was sealed', async () => {
    const { recomputation: r, seal } = recomputation();
    await expect(verifyRecomputation(r, readerOf(seal))).resolves.toMatchObject({ result: 'MATCH' });
  });

  it('names the section that changed since sealing', async () => {
    const { recomputation: r, seal } = recomputation();
    r.recomputedManifest = { ...r.recomputedManifest, audit: { count: 1, sha256: 'f'.repeat(64) } };
    await expect(verifyRecomputation(r, readerOf(seal))).resolves.toMatchObject({
      result: 'MISMATCH',
      mismatched: ['audit'],
    });
  });

  it("refuses OctaP's own record of the seal when it disagrees with the chain", async () => {
    const { recomputation: r, seal } = recomputation();
    r.sealedManifest = { ...r.sealedManifest, ledger: { count: 0, sha256: sha256Hex('') } };
    r.recomputedManifest = r.sealedManifest;
    await expect(verifyRecomputation(r, readerOf(seal))).resolves.toMatchObject({ mismatched: ['manifest'] });
  });

  it('cannot check a period that is not sealed yet', async () => {
    const { recomputation: r, seal } = recomputation();
    await expect(verifyRecomputation({ ...r, seal: null }, readerOf(seal))).rejects.toThrow(/not sealed yet/);
  });
});

describe('parseSeal', () => {
  it('reads the Move struct bytes, an empty previous hash as null', () => {
    const { seal } = bundleAndSeal();
    const fields = { ...seal } as Partial<OnChainSeal>;
    delete fields.transactionDigest;
    expect(parseSeal(encodeSealForTesting(fields as OnChainSeal), 'SealTx')).toEqual(seal);
    const chained = { ...(fields as OnChainSeal), previousManifestHash: 'd'.repeat(64) };
    expect(parseSeal(encodeSealForTesting(chained), null).previousManifestHash).toBe('d'.repeat(64));
  });
});
