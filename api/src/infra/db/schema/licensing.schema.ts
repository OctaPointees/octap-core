import { sql } from 'drizzle-orm';
import type { LicenseEntitlements } from '@octap/contracts';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
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

export const licenseTierEnum = pgEnum('license_tier', ['TRIAL', 'STARTER', 'GROWTH', 'ENTERPRISE']);
export const licenseSourceEnum = pgEnum('license_source', ['TRIAL', 'MIGRATION', 'PURCHASE', 'ADMIN']);
export const licenseExpiryStageEnum = pgEnum('license_expiry_stage', [
  'DAYS_30',
  'DAYS_7',
  'DAYS_1',
  'GRACE',
  'EXPIRED',
]);

/**
 * LICENSE PLAN: one tier of the catalogue, managed by the System Admin (OCT-329). Platform data, not a
 * tenant's: every organization reads the same catalogue. A plan is never deleted, only made
 * inactive, because licenses keep pointing at the plan they were granted from. Platform-wide: read
 * and written as the connection owner only. RLS is on with no policy, so code running under a tenant
 * (`withTenant`) can't read or change prices and entitlements.
 */
export const licensePlans = pgTable(
  'license_plans',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tier: licenseTierEnum('tier').notNull(),
    name: text('name').notNull(),
    /** One month, an integer in VND: an order costs this times the months bought. */
    monthlyPriceVnd: integer('monthly_price_vnd').notNull(),
    /** The terms it is sold for, in months; empty for a plan that runs `durationDays` instead. */
    termMonthsAllowed: integer('term_months_allowed')
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
    /** A fixed length in days (the trial), instead of months. */
    durationDays: integer('duration_days'),
    entitlements: jsonb('entitlements').$type<LicenseEntitlements>().notNull(),
    /** Offered to Owners. The trial and contract plans are granted, not bought. */
    purchasable: boolean('purchasable').default(true).notNull(),
    active: boolean('active').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check('license_plans_price_not_negative', sql`${t.monthlyPriceVnd} >= 0`),
    check('license_plans_duration_positive', sql`${t.durationDays} is null or ${t.durationDays} > 0`),
  ],
).enableRLS();

/**
 * LICENSE: what one organization may use, from `starts_at` to `ends_at` (OCT-329). The plan's
 * entitlements are copied in when it is created, so editing a plan never changes a license already
 * granted. Its state (ACTIVE, GRACE, EXPIRED) is worked out from the dates, never stored. An
 * organization keeps every license it had; the current one is the latest that has started.
 */
export const licenses = pgTable(
  'licenses',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id')
      .notNull()
      .references(() => licensePlans.id),
    tier: licenseTierEnum('tier').notNull(),
    planName: text('plan_name').notNull(),
    entitlements: jsonb('entitlements').$type<LicenseEntitlements>().notNull(),
    source: licenseSourceEnum('source').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    /** The last `license.expiry_notice` stage sent; only moves forward, so a stage is sent once. */
    expiryNoticeStage: licenseExpiryStageEnum('expiry_notice_stage'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('licenses_organization_starts_idx').on(t.organizationId, t.startsAt),
    check('licenses_ends_after_start', sql`${t.endsAt} > ${t.startsAt}`),
    pgPolicy('tenant_isolation_licenses', {
      for: 'all',
      to: authenticatedRole,
      using: sql`${t.organizationId}::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id'))`,
    }),
  ],
);

/**
 * LICENSE USAGE: the transactions counted against one license month (OCT-329). A transaction takes
 * one when it is accepted, in the same transaction, with a conditional update that stops at 110% of
 * `transactionsMonthly`, so concurrent accepts can't overshoot; one that ends FAILED gives it back.
 * `warned_80_at` and `warned_100_at` make each warning go out once per month.
 */
export const licenseUsage = pgTable(
  'license_usage',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    licenseId: uuid('license_id')
      .notNull()
      .references(() => licenses.id, { onDelete: 'cascade' }),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    transactions: integer('transactions').default(0).notNull(),
    warned80At: timestamp('warned_80_at', { withTimezone: true }),
    warned100At: timestamp('warned_100_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('license_usage_license_period_idx').on(t.licenseId, t.periodStart),
    check('license_usage_transactions_not_negative', sql`${t.transactions} >= 0`),
    pgPolicy('tenant_isolation_license_usage', {
      for: 'all',
      to: authenticatedRole,
      using: sql`${t.organizationId}::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id'))`,
    }),
  ],
);

export const licenseOrderStatusEnum = pgEnum('license_order_status', ['PENDING', 'PAID', 'CANCELED']);

/**
 * LICENSE ORDER: an Owner's order to buy or renew a license, paid by bank transfer (OCT-330). The
 * amount is the plan's monthly price times the term, worked out on the server. `payment_code` is
 * what the transfer content carries, so a payment finds its order. `EXPIRED` isn't stored: it is a
 * PENDING order past `expires_at`.
 */
export const licenseOrders = pgTable(
  'license_orders',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id')
      .notNull()
      .references(() => licensePlans.id),
    tier: licenseTierEnum('tier').notNull(),
    planName: text('plan_name').notNull(),
    termMonths: integer('term_months').notNull(),
    amountVnd: integer('amount_vnd').notNull(),
    paymentCode: text('payment_code').notNull(),
    status: licenseOrderStatusEnum('status').default('PENDING').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdById: uuid('created_by_id').references(() => systemUsers.id, { onDelete: 'set null' }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('license_orders_payment_code_idx').on(t.paymentCode),
    index('license_orders_organization_created_idx').on(t.organizationId, t.createdAt),
    check('license_orders_amount_positive', sql`${t.amountVnd} > 0`),
    check('license_orders_term_positive', sql`${t.termMonths} > 0`),
    pgPolicy('tenant_isolation_license_orders', {
      for: 'all',
      to: authenticatedRole,
      using: sql`${t.organizationId}::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id'))`,
    }),
  ],
);
