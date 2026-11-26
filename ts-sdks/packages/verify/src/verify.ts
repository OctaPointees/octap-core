import type { EvidenceBundle, EvidenceManifest, EvidenceRecomputation } from '@octap/contracts';
import { BUNDLE_FORMAT, MANIFEST_FORMAT, buildManifest, differingSections, manifestHash } from './manifest.js';
import type { OnChainSeal, SealReader } from './seal.js';

export type VerificationVerdict = 'MATCH' | 'MISMATCH';

/**
 * What disagrees with the seal:
 * - `ledger` / `audit`: that section's facts are not the ones sealed.
 * - `manifest`: the manifest itself is not the one sealed (another organization, period or chain link).
 * - `seal`: there is no genuine seal at that id.
 */
export type MismatchedPart = 'ledger' | 'audit' | 'manifest' | 'seal';

export interface VerificationResult {
  result: VerificationVerdict;
  mismatched: MismatchedPart[];
  /** One plain sentence per problem, empty on MATCH. */
  reasons: string[];
  /** The seal as read from the chain, null if there is none. */
  seal: OnChainSeal | null;
}

/**
 * Checks a downloaded bundle against its seal on Sui: recomputes every hash from the facts in the
 * file, then compares with the seal read straight from the chain. Trusts nothing in the file
 * except the facts themselves, and no package but the one shipped for that network.
 */
export async function verifyBundle(bundle: EvidenceBundle, reader: SealReader): Promise<VerificationResult> {
  if (bundle?.format !== BUNDLE_FORMAT || bundle.manifest?.format !== MANIFEST_FORMAT)
    throw new Error(`Not an Octap evidence bundle (expected format "${BUNDLE_FORMAT}")`);
  const rebuilt = buildManifest({
    organizationId: bundle.manifest.organizationId,
    periodStart: bundle.manifest.periodStart,
    periodEnd: bundle.manifest.periodEnd,
    previousManifestHash: bundle.manifest.previousManifestHash,
    ledger: bundle.ledger,
    audit: bundle.audit,
  });
  const seal = await reader.readSeal(bundle.seal.sealObjectId);
  if (!seal) return noSeal(bundle.seal.sealObjectId);

  const problems = linkProblems(bundle.manifest, seal);
  if (manifestHash(rebuilt) === seal.manifestHash && !problems.length) return match(seal);

  // The facts don't hash to the seal. Say which section, when the file's own manifest is the sealed one.
  if (manifestHash(bundle.manifest) === seal.manifestHash && !problems.length) {
    const parts = differingSections(bundle.manifest, rebuilt);
    return mismatch(
      seal,
      parts,
      parts.map((part) => `The ${part} facts in this file are not the ones sealed`),
    );
  }
  return mismatch(seal, ['manifest'], problems.length ? problems : ['This file was not sealed under this seal']);
}

/**
 * The Console's Verify button: is the database still what was sealed? Core sends the manifest as
 * sealed and the same period recomputed now; this checks both against the seal on Sui, so the
 * verdict does not rest on OctaP's word.
 */
export async function verifyRecomputation(
  recomputation: EvidenceRecomputation,
  reader: SealReader,
): Promise<VerificationResult> {
  if (!recomputation.seal) throw new Error('This period is not sealed yet');
  const seal = await reader.readSeal(recomputation.seal.sealObjectId);
  if (!seal) return noSeal(recomputation.seal.sealObjectId);

  const sealed = recomputation.sealedManifest;
  const problems = linkProblems(sealed, seal);
  if (problems.length || manifestHash(sealed) !== seal.manifestHash)
    return mismatch(
      seal,
      ['manifest'],
      problems.length ? problems : ["OctaP's record of this seal does not match the chain"],
    );

  if (manifestHash(recomputation.recomputedManifest) === seal.manifestHash) return match(seal);
  const parts = differingSections(sealed, recomputation.recomputedManifest);
  const mismatched: MismatchedPart[] = parts.length ? parts : ['manifest'];
  return mismatch(
    seal,
    mismatched,
    mismatched.map((part) => `The ${part} data has changed since it was sealed`),
  );
}

/** Whether the manifest names the same organization, period and chain link as the seal. */
function linkProblems(manifest: EvidenceManifest, seal: OnChainSeal): string[] {
  const problems: string[] = [];
  if (manifest.organizationId !== seal.organizationId) problems.push('The seal belongs to another organization');
  if (Date.parse(manifest.periodStart) !== seal.periodStartMs || Date.parse(manifest.periodEnd) !== seal.periodEndMs)
    problems.push('The seal covers another period');
  if ((manifest.previousManifestHash ?? null) !== seal.previousManifestHash)
    problems.push('The seal follows another previous period');
  return problems;
}

function match(seal: OnChainSeal): VerificationResult {
  return { result: 'MATCH', mismatched: [], reasons: [], seal };
}

function mismatch(seal: OnChainSeal | null, mismatched: MismatchedPart[], reasons: string[]): VerificationResult {
  return { result: 'MISMATCH', mismatched, reasons, seal };
}

function noSeal(id: string): VerificationResult {
  return mismatch(null, ['seal'], [`There is no Octap evidence seal at ${id}`]);
}
