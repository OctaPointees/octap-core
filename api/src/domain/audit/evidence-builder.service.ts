import { Injectable } from '@nestjs/common';
import type {
  EvidenceAuditFact,
  EvidenceBundle,
  EvidenceLedgerFact,
  EvidenceManifest,
  EvidenceSealReference,
} from '@octap/contracts';
import { AUDIT_NETWORKS, BUNDLE_FORMAT, MANIFEST_FORMAT, buildManifest, manifestHash } from '@octap/verify';
import type { DrizzleDb } from '#infra/db/postgres.provider.js';
import { EvidenceRepository, type EvidencePeriodRow } from '#infra/db/repositories/evidence.repository.js';

/** How long one evidence period lasts. A day by default; minutes for a demo. */
export function evidencePeriodMs(): number {
  return Number(process.env.EVIDENCE_PERIOD_MS ?? 86_400_000);
}

/** The start of the period `at` falls in. Periods are aligned to the Unix epoch, so a day is a UTC day. */
export function periodStartOf(at: Date, periodMs = evidencePeriodMs()): Date {
  return new Date(Math.floor(at.getTime() / periodMs) * periodMs);
}

export interface BuiltPeriod {
  manifest: EvidenceManifest;
  manifestHash: string;
  ledger: EvidenceLedgerFact[];
  audit: EvidenceAuditFact[];
}

/**
 * Builds a period's evidence from the database (OCT-77). The one place that turns rows into a
 * manifest: the worker seals what it builds, and a bundle or a check builds the same period again,
 * so any later change to the rows shows up as a different hash.
 */
@Injectable()
export class EvidenceBuilder {
  constructor(private readonly evidence: EvidenceRepository) {}

  async build(
    db: DrizzleDb,
    organizationId: string,
    start: Date,
    end: Date,
    previousManifestHash: string | null,
  ): Promise<BuiltPeriod> {
    const ledger = await this.evidence.ledgerFacts(db, organizationId, start, end);
    const audit = await this.evidence.auditFacts(db, organizationId, start, end);
    const manifest = buildManifest({
      organizationId,
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      ledger,
      audit,
      previousManifestHash,
    });
    return { manifest, manifestHash: manifestHash(manifest), ledger, audit };
  }

  /** A period's manifest as it was sealed, from the hashes recorded with it. */
  sealedManifest(period: EvidencePeriodRow): EvidenceManifest {
    return {
      format: MANIFEST_FORMAT,
      organizationId: period.organizationId,
      periodStart: period.periodStart.toISOString(),
      periodEnd: period.periodEnd.toISOString(),
      ledger: { count: period.ledgerCount, sha256: period.ledgerHash },
      audit: { count: period.auditCount, sha256: period.auditHash },
      previousManifestHash: period.previousManifestHash,
    };
  }

  /** Where the period's seal is on Sui, null while it is still SEALING. */
  sealReference(period: EvidencePeriodRow): EvidenceSealReference | null {
    if (period.status !== 'SEALED' || !period.sealObjectId || !period.sealedAt) return null;
    return {
      network: period.network,
      packageId: (AUDIT_NETWORKS as Record<string, { packageId: string } | undefined>)[period.network]?.packageId ?? '',
      sealObjectId: period.sealObjectId,
      transactionDigest: period.sealDigest ?? '',
      sealedAt: period.sealedAt.toISOString(),
    };
  }

  /**
   * The file an Owner hands to an auditor: the manifest as sealed, and the period's facts as the
   * database holds them now. If a fact changed after sealing, the verifier says which section.
   */
  async bundle(db: DrizzleDb, period: EvidencePeriodRow): Promise<EvidenceBundle> {
    const seal = this.sealReference(period);
    if (!seal) throw new Error(`Evidence period ${period.id} is not sealed yet`);
    const built = await this.build(
      db,
      period.organizationId,
      period.periodStart,
      period.periodEnd,
      period.previousManifestHash,
    );
    return {
      format: BUNDLE_FORMAT,
      manifest: this.sealedManifest(period),
      manifestHash: period.manifestHash,
      seal,
      ledger: built.ledger,
      audit: built.audit,
    };
  }
}
