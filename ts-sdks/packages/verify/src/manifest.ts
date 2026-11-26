import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { EvidenceAuditFact, EvidenceLedgerFact, EvidenceManifest, EvidenceSection } from '@octap/contracts';

export const MANIFEST_FORMAT = 'octap.evidence.manifest/v1' as const;
export const BUNDLE_FORMAT = 'octap.evidence/v1' as const;

/**
 * Canonical JSON: object keys sorted, no whitespace, `undefined` fields left out. Numbers and
 * strings serialize as `JSON.stringify` does, which is what RFC 8785 (JCS) specifies for them.
 * The same value always gives the same text, on any machine.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
    if (value === undefined || typeof value === 'function' || typeof value === 'bigint')
      throw new Error(`canonicalJson: unsupported ${typeof value}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

/** A section's hash: sha256 of its facts, one canonical JSON line each, every line ending in `\n`. */
export function sectionOf(facts: readonly (EvidenceLedgerFact | EvidenceAuditFact)[]): EvidenceSection {
  return { count: facts.length, sha256: sha256Hex(facts.map((fact) => `${canonicalJson(fact)}\n`).join('')) };
}

export interface ManifestInput {
  organizationId: string;
  periodStart: string;
  periodEnd: string;
  ledger: readonly EvidenceLedgerFact[];
  audit: readonly EvidenceAuditFact[];
  previousManifestHash: string | null;
}

/** The manifest of one period. Facts must already be in their canonical order (see Core's builder). */
export function buildManifest(input: ManifestInput): EvidenceManifest {
  return {
    format: MANIFEST_FORMAT,
    organizationId: input.organizationId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    ledger: sectionOf(input.ledger),
    audit: sectionOf(input.audit),
    previousManifestHash: input.previousManifestHash,
  };
}

/** The value sealed on-chain. */
export function manifestHash(manifest: EvidenceManifest): string {
  return sha256Hex(canonicalJson(manifest));
}

/** Which sections of two manifests of the same period differ. */
export function differingSections(a: EvidenceManifest, b: EvidenceManifest): ('ledger' | 'audit')[] {
  const out: ('ledger' | 'audit')[] = [];
  if (a.ledger.sha256 !== b.ledger.sha256 || a.ledger.count !== b.ledger.count) out.push('ledger');
  if (a.audit.sha256 !== b.audit.sha256 || a.audit.count !== b.audit.count) out.push('audit');
  return out;
}
