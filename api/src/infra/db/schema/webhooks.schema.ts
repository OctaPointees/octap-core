import { sql } from 'drizzle-orm';
import { index, integer, pgEnum, pgPolicy, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { authenticatedRole } from 'drizzle-orm/supabase';
import { organizationEvents } from './events.schema.js';
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
 * WEBHOOK DELIVERY: one organization event queued for one endpoint. The event (`eventId`) holds the
 * type and payload and its id is what the endpoint sees as `X-OctaP-Event-Id`, the same for every
 * endpoint and across retries or a manual replay. `id` names this delivery (replay, the console list).
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
    eventId: uuid('event_id')
      .notNull()
      .references(() => organizationEvents.id, { onDelete: 'cascade' }),
    status: webhookDeliveryStatusEnum('status').default('PENDING').notNull(),
    attemptCount: integer('attempt_count').default(0).notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
    lastResponseStatus: integer('last_response_status'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('webhook_deliveries_event_idx').on(t.eventId),
    pgPolicy('tenant_manage_webhook_deliveries', {
      for: 'all',
      to: authenticatedRole,
      using: sql`${t.organizationId}::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id'))`,
    }),
  ],
);
