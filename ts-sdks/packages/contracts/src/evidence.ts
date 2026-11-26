/**
 * Audit evidence (OCT-77). At the end of each period, Core seals each organization's activity on
 * Sui: its confirmed ledger facts and its audit log rows, hashed into a manifest. Anyone holding a
 * period's bundle can check it against that seal without trusting OctaP (`@octap/verify`).
 *
 * `GET /v1/console/organizations/{organizationId}/evidence…`, Owner only.
 */

/** `SEALING` while the seal is on its way to the chain, then `SEALED` for good. */
export type EvidencePeriodStatus = 'SEALING' | 'SEALED';

/** The encrypted copy on Walrus. `DISABLED` when this deployment keeps no copy, `SKIPPED` for an empty period. */
export type EvidenceArchiveStatus = 'PENDING' | 'ARCHIVED' | 'DISABLED' | 'SKIPPED';

/**
 * One loyalty transaction confirmed on-chain during the period. Only facts that never change once
 * confirmed: no status (a reversal is its own fact, in the period it happened) and no checkpoint
 * (filled in later by the indexer).
 */
export interface EvidenceLedgerFact {
  id: string;
  type: string;
  pointsAmount: number;
  purchaseAmount: number | null;
  /** The member's id in the organization. */
  memberId: string;
  receiptReference: string | null;
  /** On a REVERSAL, the transaction it reverses. */
  reversesTransactionId: string | null;
  /** The Sui transaction that carried it. */
  digest: string;
  confirmedAt: string;
}

/** One audit log row of the period (OCT-333). Append-only, so it never changes. */
export interface EvidenceAuditFact {
  id: string;
  occurredAt: string;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  requestId: string | null;
  changes: Record<string, unknown> | null;
}

export interface EvidenceSection {
  count: number;
  /** sha256 (hex) of the section's facts, one canonical JSON line each. */
  sha256: string;
}

/** What is sealed: its sha256 is the seal's `manifest_hash`. */
export interface EvidenceManifest {
  format: 'octap.evidence.manifest/v1';
  organizationId: string;
  periodStart: string;
  periodEnd: string;
  ledger: EvidenceSection;
  audit: EvidenceSection;
  /** The organization's previous sealed manifest, null on its first. */
  previousManifestHash: string | null;
}

/** Where a period's seal is on Sui. */
export interface EvidenceSealReference {
  network: string;
  packageId: string;
  sealObjectId: string;
  transactionDigest: string;
  sealedAt: string;
}

/** The file an Owner downloads and hands to an auditor. The same period always gives the same file. */
export interface EvidenceBundle {
  format: 'octap.evidence/v1';
  manifest: EvidenceManifest;
  manifestHash: string;
  seal: EvidenceSealReference;
  ledger: EvidenceLedgerFact[];
  audit: EvidenceAuditFact[];
}

export interface EvidencePeriodSummary {
  id: string;
  periodStart: string;
  periodEnd: string;
  ledgerCount: number;
  auditCount: number;
  status: EvidencePeriodStatus;
  archiveStatus: EvidenceArchiveStatus;
}

export interface EvidencePeriodPage {
  /** The end of the organization's latest sealed period, null before its first. */
  sealedThrough: string | null;
  /** How many periods are sealed. */
  periodCount: number;
  /** Newest first. */
  items: EvidencePeriodSummary[];
  nextCursor: string | null;
}

export interface EvidencePeriodDetail extends EvidencePeriodSummary {
  manifestHash: string;
  previousManifestHash: string | null;
  /** Null while SEALING. */
  seal: EvidenceSealReference | null;
  archive: { status: EvidenceArchiveStatus; walrusBlobId: string | null; archivedAt: string | null };
}

/**
 * For the Console's Verify button: the manifest as sealed, and the same period recomputed from the
 * database now. The browser checks both against the seal read straight from Sui
 * (`verifyRecomputation` in `@octap/verify`), so the verdict never rests on OctaP's word.
 */
export interface EvidenceRecomputation {
  periodId: string;
  sealedManifest: EvidenceManifest;
  recomputedManifest: EvidenceManifest;
  /** Null while SEALING: there is nothing on-chain to check against yet. */
  seal: EvidenceSealReference | null;
  computedAt: string;
}

/** Newest first. `limit` 1–100 (default 30), `cursor` from the last page's `nextCursor`. */
export interface EvidencePeriodQuery {
  limit?: number;
  cursor?: string;
}
