import { sql } from 'drizzle-orm';
import { bigint, index, integer, jsonb, pgPolicy, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { authenticatedRole } from 'drizzle-orm/supabase';
import { apiCredentials, organizations } from './organizations.schema.js';

/**
 * API REQUEST LOG (OCT-298): one row per call an API key made, for the organization's developers to
 * read in the console. Append-only, deleted after 30 days (`RequestLogRetentionWorker`). Not an audit
 * trail: a failed write is logged and dropped, and old rows go away. Who changed what lives in
 * `organization_events`.
 *
 * Only calls that authenticated with a key are here: a console session, a public route or an
 * unknown key has no organization to log under. `request_id` is the correlation id (OCT-60), the
 * same as the `X-Request-Id` response header and this process's access log line. `sequence` only
 * orders rows for the live tail.
 */
export const apiRequestLogs = pgTable(
  'api_request_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sequence: bigint('sequence', { mode: 'number' }).generatedAlwaysAsIdentity().notNull().unique(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    credentialId: uuid('credential_id')
      .notNull()
      .references(() => apiCredentials.id, { onDelete: 'cascade' }),
    requestId: uuid('request_id').notNull().unique(),
    method: text('method').notNull(),
    /** The matched route template (OpenTelemetry `http.route`), so calls to one endpoint group together. */
    route: text('route').notNull(),
    /** The path called, without its query string (a query can carry tokens). */
    path: text('path').notNull(),
    statusCode: integer('status_code').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    category: text('category').notNull(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    /** A non-2xx response's body, capped in size. Never a 2xx body. */
    errorBody: jsonb('error_body'),
    userAgent: text('user_agent'),
    /** When the request arrived. */
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('api_request_logs_org_created_idx').on(t.organizationId, t.createdAt),
    index('api_request_logs_org_credential_created_idx').on(t.organizationId, t.credentialId, t.createdAt),
    index('api_request_logs_created_idx').on(t.createdAt),
    pgPolicy('tenant_read_api_request_logs', {
      for: 'all',
      to: authenticatedRole,
      using: sql`${t.organizationId}::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id'))`,
    }),
  ],
);
