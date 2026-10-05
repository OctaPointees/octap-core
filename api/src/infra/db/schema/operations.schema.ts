import { sql } from 'drizzle-orm';
import { jsonb, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { authenticatedRole } from 'drizzle-orm/supabase';
import { organizations } from './organizations.schema.js';

/**
 * Durable operations, idempotency keys, and command status tracking.
 * Includes tenant isolation RLS policy.
 */
export const operations = pgTable(
  'operations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    commandType: text('command_type').notNull(),
    status: text('status').notNull().default('PENDING'),
    payload: jsonb('payload').default({}),
    suiTxDigest: text('sui_tx_digest'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('operations_tenant_idempotency_idx').on(t.tenantId, t.idempotencyKey),
    pgPolicy('tenant_isolation_operations', {
      for: 'all',
      to: authenticatedRole,
      using: sql`${t.tenantId}::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id'))`,
    }),
  ],
);
