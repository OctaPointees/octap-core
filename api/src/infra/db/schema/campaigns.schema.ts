import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { authenticatedRole } from 'drizzle-orm/supabase';
import { organizations } from './organizations.schema.js';
import { systemUsers } from './auth.schema.js';

/**
 * DRAFT until an Owner activates it (that is its approval). ACTIVE and PAUSED move back and forth;
 * ENDED (closed early by the Owner, or by the system once `endsAt` has passed, OCT-343) and ARCHIVED
 * are final.
 */
export const campaignStatusEnum = pgEnum('campaign_status', ['DRAFT', 'ACTIVE', 'PAUSED', 'ENDED', 'ARCHIVED']);

/**
 * CAMPAIGN (OCT-340): an organization's named, time-boxed promotion ("Tết 2027", "weekend 2x points").
 * It can boost earn (`multiplierBps`, applied only to an earn that names the campaign, while it is
 * ACTIVE within `[startsAt, endsAt]`), and group vouchers (`vouchers.campaign_id`), or both. The
 * multiplier is enforced on-chain too (`credit_account::earn`, at most 10x), and every boosted earn
 * still comes out of the program's issuance budget.
 */
export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    status: campaignStatusEnum('status').default('DRAFT').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    /** The earn boost in basis points (20000 is 2x); null for a campaign that only groups vouchers. */
    multiplierBps: integer('multiplier_bps'),
    createdByUserId: uuid('created_by_user_id').references(() => systemUsers.id, { onDelete: 'set null' }),
    /** The Owner whose first activation approved it; null while DRAFT, or once that user is deleted. */
    approvedByUserId: uuid('approved_by_user_id').references(() => systemUsers.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('campaigns_org_created_idx').on(t.organizationId, t.createdAt),
    // Target of the (organization_id, campaign_id) keys: a row's campaign is its own organization's.
    uniqueIndex('campaigns_org_id_idx').on(t.organizationId, t.id),
    check('campaigns_window', sql`${t.endsAt} > ${t.startsAt}`),
    // Same range `credit_account::earn` accepts, minus 1x, which would boost nothing.
    check(
      'campaigns_multiplier_range',
      sql`${t.multiplierBps} is null or (${t.multiplierBps} > 10000 and ${t.multiplierBps} <= 100000)`,
    ),
    pgPolicy('tenant_manage_campaigns', {
      for: 'all',
      to: authenticatedRole,
      using: sql`${t.organizationId}::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id'))`,
    }),
  ],
);
