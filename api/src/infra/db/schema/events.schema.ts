import { sql } from 'drizzle-orm';
import { bigint, index, jsonb, pgPolicy, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { authenticatedRole } from 'drizzle-orm/supabase';
import { organizations } from './organizations.schema.js';

/**
 * ORGANIZATION EVENT: the outbox (OCT-325). One row per thing that happened to an organization,
 * written by `recordEvent` in the same transaction as the change it describes, whether or not the
 * organization has a webhook endpoint. Webhook deliveries fan out from it; the console stream
 * (OCT-326) and an audit log read it.
 *
 * `id` is the event's identity everywhere: the webhook body's `id` and `x-octap-event-id`, the same
 * for every endpoint and across retries and replays. `sequence` only orders events for a reader that
 * resumes from the last one it saw. It is assigned at insert, not at commit, so a reader must not
 * assume a lower sequence has always committed before a higher one.
 */
export const organizationEvents = pgTable(
  'organization_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sequence: bigint('sequence', { mode: 'number' }).generatedAlwaysAsIdentity().notNull().unique(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('organization_events_org_sequence_idx').on(t.organizationId, t.sequence),
    pgPolicy('tenant_manage_organization_events', {
      for: 'all',
      to: authenticatedRole,
      using: sql`${t.organizationId}::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id'))`,
    }),
  ],
);
