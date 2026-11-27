import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, gte, lt, max, min, sql } from 'drizzle-orm';
import type { EvidenceAuditFact, EvidenceLedgerFact } from '@octap/contracts';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { auditLog } from '../schema/audit.schema.js';
import { blockchainTransactions, loyaltyTransactions } from '../schema/credits.schema.js';
import { evidencePeriods } from '../schema/evidence.schema.js';
import { organizations } from '../schema/organizations.schema.js';
import { withTenant } from '../rls.js';

export type EvidencePeriodRow = typeof evidencePeriods.$inferSelect;
export type NewEvidencePeriod = Omit<
  typeof evidencePeriods.$inferInsert,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'sealObjectId' | 'sealDigest' | 'sealedAt'
>;

/**
 * Evidence periods (OCT-77) and the facts they seal. The fact reads are the one definition of what
 * a period contains: the worker seals what they return, and a later bundle or check rebuilds the
 * period from them again.
 */
@Injectable()
export class EvidenceRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  /**
   * The period's ledger facts: loyalty transactions whose Sui transaction was confirmed in
   * `[start, end)`, in confirmation order. Only fields that never change once confirmed. Sandbox
   * activity has tables of its own, so it never appears.
   */
  ledgerFacts(db: DrizzleDb, organizationId: string, start: Date, end: Date): Promise<EvidenceLedgerFact[]> {
    return withTenant(db, organizationId, async (tx) => {
      const rows = await tx
        .select({
          id: loyaltyTransactions.id,
          type: loyaltyTransactions.transactionType,
          pointsAmount: loyaltyTransactions.pointsAmount,
          purchaseAmount: loyaltyTransactions.purchaseAmount,
          memberId: loyaltyTransactions.organizationEndUserId,
          receiptReference: loyaltyTransactions.receiptReference,
          reversesTransactionId: loyaltyTransactions.reversesTransactionId,
          digest: blockchainTransactions.digest,
          confirmedAt: blockchainTransactions.confirmedAt,
        })
        .from(loyaltyTransactions)
        .innerJoin(blockchainTransactions, eq(blockchainTransactions.id, loyaltyTransactions.blockchainTransactionId))
        .where(
          and(
            eq(loyaltyTransactions.organizationId, organizationId),
            eq(blockchainTransactions.status, 'CONFIRMED'),
            gte(blockchainTransactions.confirmedAt, start),
            lt(blockchainTransactions.confirmedAt, end),
          ),
        )
        .orderBy(asc(blockchainTransactions.confirmedAt), asc(loyaltyTransactions.id));
      return rows.map((row) => ({ ...row, confirmedAt: row.confirmedAt!.toISOString() }));
    });
  }

  /** The period's audit log rows (OCT-333), written in `[start, end)`, in log order. */
  auditFacts(db: DrizzleDb, organizationId: string, start: Date, end: Date): Promise<EvidenceAuditFact[]> {
    return withTenant(db, organizationId, async (tx) => {
      const rows = await tx
        .select({
          id: auditLog.id,
          occurredAt: auditLog.occurredAt,
          actorType: auditLog.actorType,
          actorId: auditLog.actorId,
          action: auditLog.action,
          targetType: auditLog.targetType,
          targetId: auditLog.targetId,
          requestId: auditLog.requestId,
          changes: auditLog.changes,
        })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.organizationId, organizationId),
            gte(auditLog.occurredAt, start),
            lt(auditLog.occurredAt, end),
          ),
        )
        .orderBy(asc(auditLog.sequence));
      return rows.map((row) => ({
        ...row,
        occurredAt: row.occurredAt.toISOString(),
        changes: (row.changes as Record<string, unknown> | null) ?? null,
      }));
    });
  }

  /** When the organization's first activity at or after `from` happened, or null if none yet. */
  async firstActivityFrom(organizationId: string, from: Date): Promise<Date | null> {
    return withTenant(this.db, organizationId, async (tx) => {
      const [ledger] = await tx
        .select({ at: min(blockchainTransactions.confirmedAt) })
        .from(loyaltyTransactions)
        .innerJoin(blockchainTransactions, eq(blockchainTransactions.id, loyaltyTransactions.blockchainTransactionId))
        .where(
          and(
            eq(loyaltyTransactions.organizationId, organizationId),
            eq(blockchainTransactions.status, 'CONFIRMED'),
            gte(blockchainTransactions.confirmedAt, from),
          ),
        );
      const [audit] = await tx
        .select({ at: min(auditLog.occurredAt) })
        .from(auditLog)
        .where(and(eq(auditLog.organizationId, organizationId), gte(auditLog.occurredAt, from)));
      const times = [ledger?.at, audit?.at].filter((at): at is Date => at instanceof Date);
      return times.length ? new Date(Math.min(...times.map((at) => at.getTime()))) : null;
    });
  }

  async organizationIds(): Promise<string[]> {
    const rows = await this.db.select({ id: organizations.id }).from(organizations).orderBy(asc(organizations.id));
    return rows.map((row) => row.id);
  }

  async latest(organizationId: string): Promise<EvidencePeriodRow | null> {
    const [row] = await this.db
      .select()
      .from(evidencePeriods)
      .where(eq(evidencePeriods.organizationId, organizationId))
      .orderBy(desc(evidencePeriods.periodStart))
      .limit(1);
    return row ?? null;
  }

  async insert(period: NewEvidencePeriod): Promise<EvidencePeriodRow> {
    const [row] = await this.db.insert(evidencePeriods).values(period).returning();
    return row;
  }

  async markSealed(
    id: string,
    seal: { sealObjectId: string; sealDigest: string | null; sealedAt: Date },
  ): Promise<void> {
    await this.db
      .update(evidencePeriods)
      .set({ ...seal, status: 'SEALED', updatedAt: new Date() })
      .where(and(eq(evidencePeriods.id, id), eq(evidencePeriods.status, 'SEALING')));
  }

  /** Sealed periods whose copy is not on Walrus yet, oldest first. */
  async pendingArchives(limit: number): Promise<EvidencePeriodRow[]> {
    return this.db
      .select()
      .from(evidencePeriods)
      .where(and(eq(evidencePeriods.archiveStatus, 'PENDING'), eq(evidencePeriods.status, 'SEALED')))
      .orderBy(asc(evidencePeriods.sealedAt))
      .limit(limit);
  }

  async updateArchive(
    id: string,
    archive: Partial<
      Pick<EvidencePeriodRow, 'archiveStatus' | 'archiveFileId' | 'walrusBlobId' | 'archivedAt' | 'archiveError'>
    >,
  ): Promise<void> {
    await this.db
      .update(evidencePeriods)
      .set({ ...archive, updatedAt: new Date() })
      .where(eq(evidencePeriods.id, id));
  }

  /** Newest first, keyset-paged by row id. Null when the cursor is not one of this organization's periods. */
  async page(tx: DrizzleDb, organizationId: string, limit: number, cursor?: string) {
    return withTenant(tx, organizationId, async (t) => {
      const owner = eq(evidencePeriods.organizationId, organizationId);
      if (cursor) {
        const [anchor] = await t
          .select({ id: evidencePeriods.id })
          .from(evidencePeriods)
          .where(and(owner, eq(evidencePeriods.id, cursor)));
        if (!anchor) return null;
      }
      const rows = await t
        .select()
        .from(evidencePeriods)
        .where(
          and(
            owner,
            cursor
              ? sql`${evidencePeriods.periodStart} < (select p.period_start from ${evidencePeriods} p where p.id = ${cursor})`
              : undefined,
          ),
        )
        .orderBy(desc(evidencePeriods.periodStart))
        .limit(limit + 1);
      const more = rows.length > limit;
      if (more) rows.pop();
      const [summary] = await t
        .select({ sealedThrough: max(evidencePeriods.periodEnd), periodCount: count() })
        .from(evidencePeriods)
        .where(and(owner, eq(evidencePeriods.status, 'SEALED')));
      return {
        rows,
        nextCursor: more ? rows.at(-1)!.id : null,
        sealedThrough: summary?.sealedThrough ?? null,
        periodCount: Number(summary?.periodCount ?? 0),
      };
    });
  }

  async get(tx: DrizzleDb, organizationId: string, periodId: string): Promise<EvidencePeriodRow | null> {
    return withTenant(tx, organizationId, async (t) => {
      const [row] = await t
        .select()
        .from(evidencePeriods)
        .where(and(eq(evidencePeriods.organizationId, organizationId), eq(evidencePeriods.id, periodId)));
      return row ?? null;
    });
  }
}
