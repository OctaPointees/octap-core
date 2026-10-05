import { sql } from 'drizzle-orm';
import { jsonb, pgEnum, pgPolicy, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { authenticatedRole } from 'drizzle-orm/supabase';

export const organizationStatusEnum = pgEnum('organization_status', [
  'ACTIVE',
  'SUSPENDED',
  'PENDING_APPROVAL',
  'ARCHIVED',
]);

export const apiCredentialStatusEnum = pgEnum('api_credential_status', [
  'ACTIVE',
  'REVOKED',
  'EXPIRED',
]);

/**
 * ORGANIZATION: Merchant tenants in OctaP managing loyalty programs.
 */
export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    legalName: text('legal_name'),
    taxId: text('tax_id'),
    status: organizationStatusEnum('status').default('ACTIVE').notNull(),
    suiPackageId: text('sui_package_id'),
    suiTreasuryCap: text('sui_treasury_cap'),
    metadata: jsonb('metadata').default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    pgPolicy('tenant_members_can_view_organization', {
      for: 'select',
      to: authenticatedRole,
      using: sql`exists (
        select 1 from organization_memberships m
        where m.organization_id = ${t.id} and m.system_user_id = auth.uid()
      )`,
    }),
  ],
);

/**
 * API CREDENTIAL: API keys provisioned for merchant POS and backend integration.
 */
export const apiCredentials = pgTable(
  'api_credentials',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    keyHash: text('key_hash').notNull().unique(),
    scopes: jsonb('scopes').default(['read', 'write']).notNull(),
    status: apiCredentialStatusEnum('status').default('ACTIVE').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    pgPolicy('tenant_can_manage_api_credentials', {
      for: 'all',
      to: authenticatedRole,
      using: sql`${t.organizationId}::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id'))`,
    }),
  ],
);
