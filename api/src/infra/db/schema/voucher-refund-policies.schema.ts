import { sql } from 'drizzle-orm';
import { integer, jsonb, pgPolicy, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { authenticatedRole } from 'drizzle-orm/supabase';
import type { VoucherRefundPolicy } from '@octap/contracts';
import { organizations } from './organizations.schema.js';

/** Append-only versions. A coupon stores the terms active when it was claimed. */
export const voucherRefundPolicies = pgTable(
  'voucher_refund_policies',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    policy: jsonb('policy').$type<VoucherRefundPolicy>().notNull(),
    reason: text('reason').notNull(),
    // Historical actor identity; deliberately no FK that could erase it on credential deletion.
    createdByCredentialId: uuid('created_by_credential_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.version] }),
    pgPolicy('tenant_read_refund_policies', {
      for: 'select',
      to: authenticatedRole,
      using: sql`${t.organizationId}::text = current_setting('app.current_tenant_id', true)`,
    }),
    pgPolicy('tenant_insert_refund_policies', {
      for: 'insert',
      to: authenticatedRole,
      withCheck: sql`${t.organizationId}::text = current_setting('app.current_tenant_id', true)`,
    }),
  ],
);
