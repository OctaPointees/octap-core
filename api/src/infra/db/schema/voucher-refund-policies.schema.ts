import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgPolicy, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
    // Historical actor identity, exactly one of the two; deliberately no FK that could erase it on
    // credential or user deletion. Versions published with an API key before OCT-301 carry the
    // credential; every version since is published by an Owner from the console.
    createdByCredentialId: uuid('created_by_credential_id'),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.version] }),
    check(
      'voucher_refund_policies_one_actor',
      sql`(${t.createdByCredentialId} is null) <> (${t.createdByUserId} is null)`,
    ),
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
