import { sql } from 'drizzle-orm';
import { index, integer, pgEnum, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { authenticatedRole } from 'drizzle-orm/supabase';
import { organizations } from './organizations.schema.js';

export const evidencePeriodStatusEnum = pgEnum('evidence_period_status', ['SEALING', 'SEALED']);
export const evidenceArchiveStatusEnum = pgEnum('evidence_archive_status', ['PENDING', 'ARCHIVED', 'DISABLED']);

/**
 * EVIDENCE PERIOD (OCT-77): one sealed period of an organization's activity. The worker builds its
 * manifest (`@octap/verify`) from the ledger facts confirmed and the audit rows written in the
 * period, then seals the manifest hash on Sui (`octap_audit::evidence_seal`).
 *
 * The seal is the evidence. This row is OctaP's index of it: where the seal is, and where the
 * encrypted copy on Walrus is. The facts themselves are not copied here: a bundle or a check
 * rebuilds them from `loyalty_transactions` and `audit_log`, which is how a later change to either
 * shows up.
 *
 * Written by the worker only, as the connection's own role. The tenant role may only read it.
 */
export const evidencePeriods = pgTable(
  'evidence_periods',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    ledgerCount: integer('ledger_count').notNull(),
    ledgerHash: text('ledger_hash').notNull(),
    auditCount: integer('audit_count').notNull(),
    auditHash: text('audit_hash').notNull(),
    /** The organization's previous period's manifest hash, null on its first. */
    previousManifestHash: text('previous_manifest_hash'),
    manifestHash: text('manifest_hash').notNull(),
    status: evidencePeriodStatusEnum('status').default('SEALING').notNull(),
    /** The Sui network the seal is on, so a later network switch never misreads old seals. */
    network: text('network').notNull(),
    sealObjectId: text('seal_object_id'),
    sealDigest: text('seal_digest'),
    sealedAt: timestamp('sealed_at', { withTimezone: true }),
    archiveStatus: evidenceArchiveStatusEnum('archive_status').default('PENDING').notNull(),
    /** The Walrus Console file, once uploaded. */
    archiveFileId: text('archive_file_id'),
    walrusBlobId: text('walrus_blob_id'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    archiveError: text('archive_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('evidence_periods_org_start_idx').on(t.organizationId, t.periodStart),
    index('evidence_periods_archive_idx')
      .on(t.archiveStatus, t.status)
      .where(sql`${t.archiveStatus} = 'PENDING'`),
    pgPolicy('tenant_read_evidence_periods', {
      for: 'select',
      to: authenticatedRole,
      using: sql`${t.organizationId}::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id'))`,
    }),
  ],
);
