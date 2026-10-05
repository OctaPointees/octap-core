import { sql } from 'drizzle-orm';
import { jsonb, pgEnum, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { authenticatedRole, authUid } from 'drizzle-orm/supabase';
import { organizations } from './organizations.schema.js';

export const endUserStatusEnum = pgEnum('end_user_status', [
  'ACTIVE',
  'BLOCKED',
  'PENDING_VERIFICATION',
]);

/**
 * END USER: Global customer identities (zkLogin address, phone, email).
 */
export const endUsers = pgTable(
  'end_users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    suiAddress: text('sui_address').unique(),
    email: text('email').unique(),
    phoneNumber: text('phone_number').unique(),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    status: endUserStatusEnum('status').default('ACTIVE').notNull(),
    metadata: jsonb('metadata').default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    pgPolicy('end_users_can_view_own_profile', {
      for: 'select',
      to: authenticatedRole,
      using: sql`${t.id} = ${authUid}`,
    }),
  ],
);

/**
 * ORGANIZATION END USER: The customer's loyalty profile enrolled within a specific Organization.
 */
export const organizationEndUsers = pgTable(
  'organization_end_users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    endUserId: uuid('end_user_id')
      .notNull()
      .references(() => endUsers.id, { onDelete: 'cascade' }),
    externalMemberId: text('external_member_id'),
    tier: text('tier').default('BRONZE').notNull(),
    status: text('status').default('ACTIVE').notNull(),
    metadata: jsonb('metadata').default({}),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('org_end_user_unique_idx').on(t.organizationId, t.endUserId),
    uniqueIndex('org_external_member_id_idx').on(t.organizationId, t.externalMemberId),
    pgPolicy('tenant_or_user_access_org_end_user', {
      for: 'select',
      to: authenticatedRole,
      using: sql`${t.endUserId} = ${authUid} or ${t.organizationId}::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id'))`,
    }),
  ],
);
