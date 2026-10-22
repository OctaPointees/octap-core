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
    /** PENDING -> PROCESSING -> SUBMITTED | FAILED, or UNKNOWN if a worker died mid-PROCESSING
     * (see `recoverStaleProcessing`): the chain outcome was never learned, so this is never
     * auto-retried — that could create a second business effect. */
    status: text('status').notNull().default('PENDING'),
    payload: jsonb('payload').default({}),
    /** sha256 of `payload`'s canonical JSON (keys sorted, see `hashPayload`), so a replayed
     * idempotency key with a *different* payload is a conflict instead of silently returning (or
     * overwriting) the original. */
    payloadHash: text('payload_hash'),
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
