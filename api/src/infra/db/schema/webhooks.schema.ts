import { sql } from 'drizzle-orm';
import { integer, jsonb, pgEnum, pgPolicy, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { authenticatedRole } from 'drizzle-orm/supabase';
import { organizations } from './organizations.schema.js';

export const webhookEndpointStatusEnum = pgEnum('webhook_endpoint_status', ['ACTIVE', 'DISABLED']);
/**
 * No separate FAILED status: a failed attempt just stays PENDING with `lastError`/
 * `lastResponseStatus` set and `nextAttemptAt` pushed out, until either DELIVERED or the retry
 * budget is exhausted and it becomes DEAD_LETTER.
 */
export const webhookDeliveryStatusEnum = pgEnum('webhook_delivery_status', ['PENDING', 'DELIVERED', 'DEAD_LETTER']);

/**
 * WEBHOOK ENDPOINT: a merchant-registered URL that receives signed event deliveries.
 * `secret` is stored as plaintext (unlike api_credentials.keyHash) because the server must be
 * able to recompute the HMAC at send time — this needs a secrets manager/KMS before production;
 * see api/src/domain/webhooks/README.md.
 */
export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    secret: text('secret').notNull(),
    description: text('description'),
    status: webhookEndpointStatusEnum('status').default('ACTIVE').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    pgPolicy('tenant_manage_webhook_endpoints', {
      for: 'all',
      to: authenticatedRole,
      using: sql`${t.organizationId}::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id'))`,
    }),
  ],
);

/**
 * WEBHOOK DELIVERY: one event queued for one endpoint. `id` is the stable event identifier sent
 * as `X-OctaP-Event-Id` — it never changes across retries or a manual replay, only `status`,
 * `attemptCount`, and `nextAttemptAt` do.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    status: webhookDeliveryStatusEnum('status').default('PENDING').notNull(),
    attemptCount: integer('attempt_count').default(0).notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
    lastResponseStatus: integer('last_response_status'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    pgPolicy('tenant_manage_webhook_deliveries', {
      for: 'all',
      to: authenticatedRole,
      using: sql`${t.organizationId}::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id'))`,
    }),
  ],
);
