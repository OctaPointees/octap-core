import { sql } from 'drizzle-orm';
import { bigint, check, index, jsonb, pgEnum, pgPolicy, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { authenticatedRole } from 'drizzle-orm/supabase';
import { organizations } from './organizations.schema.js';

export const auditActorTypeEnum = pgEnum('audit_actor_type', ['USER', 'CREDENTIAL', 'SYSTEM']);

const tenant = (organizationId: unknown) =>
  sql`${organizationId}::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id'))`;

/**
 * AUDIT LOG (OCT-333): who did what to an organization, and when. One row per change, written in the
 * transaction of the change itself (`recordAudit`), so a change is never committed without its row
 * nor a row without its change.
 *
 * Durable and append-only. Nothing trims it (unlike `organization_events`, kept 30 days), the
 * tenant role may only read and insert, and a trigger refuses any UPDATE or DELETE whatever the
 * role. `sequence` orders it for a reader and for a future signed export (OCT-77).
 *
 * The shape follows the common actor / action / target model (WorkOS, Pangea, OCSF API Activity).
 * Rows hold ids, never names, emails or other personal data: the read API resolves a label at read
 * time, so personal data stays where it can be corrected or erased.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sequence: bigint('sequence', { mode: 'number' }).generatedAlwaysAsIdentity().notNull().unique(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
    actorType: auditActorTypeEnum('actor_type').notNull(),
    /** A `system_users` id for USER, an `api_credentials` id for CREDENTIAL, null for SYSTEM. */
    actorId: uuid('actor_id'),
    /** `<target>.<past-tense verb>`, e.g. `api_key.revoked`, or an outbox event type. */
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    /** The request's correlation id (OCT-60), to match a row with the request log and server logs. */
    requestId: uuid('request_id'),
    /** What changed: field names and non-personal values only. */
    changes: jsonb('changes'),
  },
  (t) => [
    index('audit_log_org_occurred_idx').on(t.organizationId, t.occurredAt, t.sequence),
    index('audit_log_org_actor_idx').on(t.organizationId, t.actorType, t.actorId, t.occurredAt),
    index('audit_log_org_target_idx').on(t.organizationId, t.targetType, t.targetId),
    check('audit_log_actor', sql`(${t.actorType} = 'SYSTEM') = (${t.actorId} is null)`),
    pgPolicy('tenant_read_audit_log', { for: 'select', to: authenticatedRole, using: tenant(t.organizationId) }),
    pgPolicy('tenant_insert_audit_log', { for: 'insert', to: authenticatedRole, withCheck: tenant(t.organizationId) }),
  ],
);
