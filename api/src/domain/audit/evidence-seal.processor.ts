import { Inject, Injectable, Logger } from '@nestjs/common';
import { DRIZZLE_DB, type DrizzleDb } from '#infra/db/postgres.provider.js';
import { EvidenceRepository, type EvidencePeriodRow } from '#infra/db/repositories/evidence.repository.js';
import { SuiClientService } from '#infra/clients/sui/sui.client.js';
import { WalrusConsoleClient } from '#infra/clients/walrus/walrus-console.client.js';
import { EvidenceBuilder, evidencePeriodMs, periodStartOf } from './evidence-builder.service.js';

/** How many periods one organization may seal in one run, so a backlog never starves the others. */
const MAX_PERIODS_PER_RUN = 24;
const ARCHIVE_BATCH_SIZE = 10;

/** How long after a period ends it is sealed: room for writes still committing at its end. */
export function evidenceSealDelayMs(): number {
  return Number(process.env.EVIDENCE_SEAL_DELAY_MS ?? 600_000);
}

/**
 * Seals each organization's finished periods on Sui, then keeps an encrypted copy of each on Walrus
 * (OCT-77). A period with no activity is skipped. An organization's periods are sealed strictly in
 * order: the chain refuses any other (`evidence_seal::seal`), so one that fails to seal holds the
 * organization's later ones until a later run gets it through.
 */
@Injectable()
export class EvidenceSealProcessor {
  private readonly logger = new Logger(EvidenceSealProcessor.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly evidence: EvidenceRepository,
    private readonly builder: EvidenceBuilder,
    private readonly sui: SuiClientService,
    private readonly walrus: WalrusConsoleClient,
  ) {}

  /** One run over every organization. Returns how many periods it sealed and archived. */
  async runOnce(now = new Date()): Promise<{ sealed: number; archived: number }> {
    let sealed = 0;
    for (const organizationId of await this.evidence.organizationIds()) {
      sealed += await this.sealOrganization(organizationId, now);
    }
    const archived = await this.archivePending();
    return { sealed, archived };
  }

  /** Seals the organization's finished periods, oldest first. */
  async sealOrganization(organizationId: string, now: Date): Promise<number> {
    const periodMs = evidencePeriodMs();
    let sealed = 0;
    for (let i = 0; i < MAX_PERIODS_PER_RUN; i++) {
      const latest = await this.evidence.latest(organizationId);
      if (latest?.status === 'SEALING') {
        if (!(await this.seal(latest))) return sealed;
        sealed++;
        continue;
      }
      const activity = await this.evidence.firstActivityFrom(organizationId, latest?.periodEnd ?? new Date(0));
      if (!activity) return sealed;
      const start = periodStartOf(activity, periodMs);
      const end = new Date(start.getTime() + periodMs);
      if (end.getTime() + evidenceSealDelayMs() > now.getTime()) return sealed;

      const built = await this.builder.build(this.db, organizationId, start, end, latest?.manifestHash ?? null);
      const period = await this.evidence.insert({
        organizationId,
        periodStart: start,
        periodEnd: end,
        ledgerCount: built.manifest.ledger.count,
        ledgerHash: built.manifest.ledger.sha256,
        auditCount: built.manifest.audit.count,
        auditHash: built.manifest.audit.sha256,
        previousManifestHash: built.manifest.previousManifestHash,
        manifestHash: built.manifestHash,
        network: this.sui.evidenceNetwork,
        archiveStatus: this.walrus.enabled ? 'PENDING' : 'DISABLED',
      });
      if (!(await this.seal(period))) return sealed;
      sealed++;
    }
    return sealed;
  }

  /**
   * Gets one SEALING period on-chain. Asks the chain first, so a seal that landed on an earlier,
   * interrupted try is recorded instead of sent twice. False when it could not get through yet.
   */
  private async seal(period: EvidencePeriodRow): Promise<boolean> {
    try {
      const onChain = await this.sui.latestEvidenceSeal(period.organizationId);
      if (
        onChain &&
        onChain.manifestHash === period.manifestHash &&
        onChain.periodStartMs === period.periodStart.getTime()
      ) {
        await this.evidence.markSealed(period.id, {
          sealObjectId: onChain.sealObjectId,
          sealDigest: onChain.transactionDigest,
          sealedAt: new Date(onChain.sealedAtMs),
        });
        return true;
      }
      const result = await this.sui.sealEvidence({
        organizationId: period.organizationId,
        periodStartMs: period.periodStart.getTime(),
        periodEndMs: period.periodEnd.getTime(),
        manifestHash: period.manifestHash,
        previousManifestHash: period.previousManifestHash,
      });
      const sealObjectId = result.eventField<string>('EvidenceSealed', 'seal_id');
      const sealedAtMs = result.eventField<string>('EvidenceSealed', 'sealed_at_ms');
      if (!sealObjectId || !sealedAtMs) throw new Error(`seal ${result.digest} emitted no EvidenceSealed event`);
      await this.evidence.markSealed(period.id, {
        sealObjectId,
        sealDigest: result.digest,
        sealedAt: new Date(Number(sealedAtMs)),
      });
      this.logger.log(
        `sealed ${period.organizationId} ${period.periodStart.toISOString()} (${period.ledgerCount} ledger, ${period.auditCount} audit) in ${result.digest}`,
      );
      return true;
    } catch (error: unknown) {
      this.logger.error(
        `sealing ${period.organizationId} ${period.periodStart.toISOString()} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /** Uploads sealed periods' bundles to Walrus Console, then records each blob id once it is stored. */
  async archivePending(): Promise<number> {
    let archived = 0;
    for (const period of await this.evidence.pendingArchives(ARCHIVE_BATCH_SIZE)) {
      try {
        if (!this.walrus.enabled) {
          await this.evidence.updateArchive(period.id, { archiveStatus: 'DISABLED' });
          continue;
        }
        if (!period.archiveFileId) {
          const bundle = await this.builder.bundle(this.db, period);
          const name = `octap-evidence-${period.organizationId}-${period.periodStart.toISOString()}.json`;
          const fileId = await this.walrus.upload(name, new TextEncoder().encode(JSON.stringify(bundle, null, 2)));
          await this.evidence.updateArchive(period.id, { archiveFileId: fileId, archiveError: null });
          continue;
        }
        const file = await this.walrus.fileState(period.archiveFileId);
        if (file.state === 'completed') {
          await this.evidence.updateArchive(period.id, {
            archiveStatus: 'ARCHIVED',
            walrusBlobId: file.blobId,
            archivedAt: new Date(),
            archiveError: null,
          });
          archived++;
        } else if (file.state === 'failed') {
          // Upload again on the next run.
          await this.evidence.updateArchive(period.id, { archiveFileId: null, archiveError: file.error });
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`archiving evidence period ${period.id} failed: ${message}`);
        await this.evidence.updateArchive(period.id, { archiveError: message.slice(0, 500) });
      }
    }
    return archived;
  }
}
