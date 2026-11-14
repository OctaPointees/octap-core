import { sql } from 'drizzle-orm';
import type { VoucherRefundPolicySnapshot } from '@octap/contracts';
import {
  bigint,
  integer,
  jsonb,
  numeric,
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
import { organizationEndUsers } from './members.schema.js';
import { loyaltyTransactions } from './credits.schema.js';

export const voucherStatusEnum = pgEnum('voucher_status', ['DRAFT', 'ACTIVE', 'PAUSED', 'EXPIRED', 'DEPLETED']);

export const voucherOwnershipStatusEnum = pgEnum('voucher_ownership_status', [
  'AVAILABLE',
  'RESERVED',
  'REDEEMED',
  'EXPIRED',
  'CANCELLED',
]);

/**
 * VOUCHER: Campaign / reward catalog definitions created by an Organization.
 */
export const voucherPublishStatusEnum = pgEnum('voucher_publish_status', [
  'NOT_PUBLISHED',
  'PUBLISHING',
  'PUBLISHED',
  'FAILED',
]);

export const vouchers = pgTable(
  'vouchers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    pointsCost: bigint('points_cost', { mode: 'number' }).default(0).notNull(),
    discountType: text('discount_type'), // 'PERCENTAGE', 'FIXED_AMOUNT', 'FREE_ITEM'; optional when `terms` is set
    discountValue: numeric('discount_value', { precision: 12, scale: 2 }),
    /** The merchant's own free-form description of the promise, published on-chain with the rest. */
    terms: jsonb('terms').$type<Record<string, unknown>>(),
    publishStatus: voucherPublishStatusEnum('publish_status').default('NOT_PUBLISHED').notNull(),
    /** The frozen `VoucherTerms`. Everything in those terms is immutable once publishing starts. */
    suiTermsId: text('sui_terms_id'),
    /** Taken when publishing starts, and published as part of the promise. */
    refundPolicySnapshot: jsonb('refund_policy_snapshot').$type<VoucherRefundPolicySnapshot>(),
    totalSupply: integer('total_supply'),
    claimedCount: integer('claimed_count').default(0).notNull(),
    status: voucherStatusEnum('status').default('DRAFT').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    metadata: jsonb('metadata').default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('voucher_org_code_idx').on(t.organizationId, t.code),
    pgPolicy('tenant_manage_vouchers', {
      for: 'all',
      to: authenticatedRole,
      using: sql`${t.organizationId}::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id'))`,
    }),
  ],
);

/**
 * VOUCHER OWNERSHIP: Specific voucher instances claimed or redeemed by an Organization End User.
 */
export const voucherOwnerships = pgTable(
  'voucher_ownerships',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    voucherId: uuid('voucher_id')
      .notNull()
      .references(() => vouchers.id, { onDelete: 'cascade' }),
    organizationEndUserId: uuid('organization_end_user_id')
      .notNull()
      .references(() => organizationEndUsers.id, { onDelete: 'cascade' }),
    loyaltyTransactionId: uuid('loyalty_transaction_id').references(() => loyaltyTransactions.id, {
      onDelete: 'set null',
    }),
    serialCode: text('serial_code').notNull().unique(),
    // Spelled out because drizzle-kit loads this file through require(), which @octap/contracts doesn't
    // export. An integration test keeps it equal to DEFAULT_VOUCHER_REFUND_POLICY.
    refundPolicySnapshot: jsonb('refund_policy_snapshot').$type<VoucherRefundPolicySnapshot>().notNull().default({
      version: 0,
      allowUnused: true,
      allowExpired: false,
      allowRedeemed: false,
      restockUnused: true,
      refundWindowDays: null,
    }),
    status: voucherOwnershipStatusEnum('status').default('AVAILABLE').notNull(),
    /**
     * The grant or use still in flight, if any. A refund is refused while it is set, so a refund can't
     * race a transaction the customer already signed.
     */
    pendingOperationId: uuid('pending_operation_id'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).defaultNow().notNull(),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('voucher_ownership_serial_idx').on(t.serialCode),
    uniqueIndex('voucher_ownership_voucher_member_idx')
      .on(t.voucherId, t.organizationEndUserId)
      .where(sql`${t.status} <> 'CANCELLED'`),
    // No organization column: a voucher a member holds belongs to the member's organization.
    pgPolicy('tenant_isolation_voucher_ownerships', {
      for: 'all',
      to: authenticatedRole,
      using: sql`exists (select 1 from ${organizationEndUsers} where ${organizationEndUsers.id} = ${t.organizationEndUserId} and ${organizationEndUsers.organizationId}::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id')))`,
    }),
  ],
);
