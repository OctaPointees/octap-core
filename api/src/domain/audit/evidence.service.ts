import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  EvidenceBundle,
  EvidencePeriodDetail,
  EvidencePeriodPage,
  EvidencePeriodSummary,
  EvidenceRecomputation,
} from '@octap/contracts';
import type { DrizzleDb } from '#infra/db/postgres.provider.js';
import { ConsoleAccessError } from '#infra/db/repositories/console-access.js';
import { ConsoleOrganizationsRepository } from '#infra/db/repositories/console-organizations.repository.js';
import { EvidenceRepository, type EvidencePeriodRow } from '#infra/db/repositories/evidence.repository.js';
import { EvidenceBuilder } from './evidence-builder.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEYS = ['limit', 'cursor'];

/**
 * The organization's sealed audit evidence (OCT-77), for its Owner: the periods, a period's seal,
 * its bundle, and a fresh recomputation for the Verify button. Owner only, like the audit log it
 * seals. Nothing here creates, edits or deletes a period: the worker seals them.
 */
@Injectable()
export class EvidenceService {
  constructor(
    private readonly organizations: ConsoleOrganizationsRepository,
    private readonly evidence: EvidenceRepository,
    private readonly builder: EvidenceBuilder,
  ) {}

  async list(userId: string, organizationId: string, input: Record<string, unknown>): Promise<EvidencePeriodPage> {
    const unknown = Object.keys(input).filter((key) => !KEYS.includes(key));
    if (unknown.length) throw new BadRequestException(`Unsupported query fields: ${unknown.join(', ')}`);
    const limit = input.limit === undefined ? 30 : Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('limit must be 1–100');
    const cursor = input.cursor;
    if (cursor !== undefined && (typeof cursor !== 'string' || !UUID.test(cursor)))
      throw new BadRequestException('Invalid cursor');
    const page = await this.asOwner(userId, organizationId, (tx) =>
      this.evidence.page(tx, organizationId, limit, cursor as string | undefined),
    );
    if (!page) throw new BadRequestException('Invalid cursor');
    return {
      sealedThrough: page.sealedThrough?.toISOString() ?? null,
      periodCount: page.periodCount,
      items: page.rows.map(toSummary),
      nextCursor: page.nextCursor,
    };
  }

  async detail(userId: string, organizationId: string, periodId: string): Promise<EvidencePeriodDetail> {
    const period = await this.asOwner(userId, organizationId, (tx) => this.period(tx, organizationId, periodId));
    return {
      ...toSummary(period),
      manifestHash: period.manifestHash,
      previousManifestHash: period.previousManifestHash,
      seal: this.builder.sealReference(period),
      archive: {
        status: period.archiveStatus,
        walrusBlobId: period.walrusBlobId,
        archivedAt: period.archivedAt?.toISOString() ?? null,
      },
    };
  }

  async bundle(userId: string, organizationId: string, periodId: string): Promise<EvidenceBundle> {
    return this.asOwner(userId, organizationId, async (tx) => {
      const period = await this.period(tx, organizationId, periodId);
      if (period.status !== 'SEALED') throw new ConflictException('This period is still being sealed');
      return this.builder.bundle(tx, period);
    });
  }

  async recompute(userId: string, organizationId: string, periodId: string): Promise<EvidenceRecomputation> {
    return this.asOwner(userId, organizationId, async (tx) => {
      const period = await this.period(tx, organizationId, periodId);
      const built = await this.builder.build(
        tx,
        organizationId,
        period.periodStart,
        period.periodEnd,
        period.previousManifestHash,
      );
      return {
        periodId: period.id,
        sealedManifest: this.builder.sealedManifest(period),
        recomputedManifest: built.manifest,
        seal: this.builder.sealReference(period),
        computedAt: new Date().toISOString(),
      };
    });
  }

  private async period(tx: DrizzleDb, organizationId: string, periodId: string): Promise<EvidencePeriodRow> {
    const period = await this.evidence.get(tx, organizationId, periodId);
    if (!period) throw new NotFoundException('Evidence period not found');
    return period;
  }

  private async asOwner<T>(userId: string, organizationId: string, action: (tx: DrizzleDb) => Promise<T>): Promise<T> {
    try {
      return await this.organizations.withOwnerAccess(userId, organizationId, (tx) =>
        action(tx as unknown as DrizzleDb),
      );
    } catch (error) {
      if (error instanceof ConsoleAccessError)
        throw new ForbiddenException('Only the active Owner of an active organization can read its audit evidence');
      throw error;
    }
  }
}

function toSummary(period: EvidencePeriodRow): EvidencePeriodSummary {
  return {
    id: period.id,
    periodStart: period.periodStart.toISOString(),
    periodEnd: period.periodEnd.toISOString(),
    ledgerCount: period.ledgerCount,
    auditCount: period.auditCount,
    status: period.status,
    archiveStatus: period.archiveStatus,
  };
}
