import { sql } from 'drizzle-orm';
import type { VoucherRefundPolicySnapshot } from '@octap/contracts';
import {
  bigint,
  check,
  foreignKey,
  index,
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
import { apiCredentials, organizations } from './organizations.schema.js';
import { systemUsers } from './auth.schema.js';
import { organizationEndUsers } from './members.schema.js';
import { loyaltyTransactions } from './credits.schema.js';

export const voucherStatusEnum = pgEnum('voucher_status', [
  'DRAFT',
  'ACTIVE',
  'PAUSED',
  'EXPIRED',
  'DEPLETED',
  'PENDING_APPROVAL',
]);
export const voucherApprovalStatusEnum = pgEnum('voucher_approval_status', [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'WITHDRAWN',
]);

export const voucherOwnershipStatusEnum = pgEnum('voucher_ownership_status', [
  'AVAILABLE',
  'RESERVED',
  'REDEEMED',
  'EXPIRED',
  'CANCELLED',
]);

/** Where a voucher batch came from (OCT-303). */
export const voucherBatchSourceEnum = pgEnum('voucher_batch_source', ['CONSOLE', 'API']);

/**
 * VOUCHER IMPORT BATCH: vouchers created together by one `createVoucherBatch` call, always as DRAFT,
 * then activated or archived together (OCT-303). An archived batch is hidden from the default list,
 * can no longer be activated, and its DRAFT vouchers' codes may be taken over by a later batch.
 */
export const voucherImportBatches = pgTable(
  'voucher_import_batches',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    source: voucherBatchSourceEnum('source').notNull(),
    /** A label to tell batches apart (a CSV file's name, a CRM's sync run); not unique. */
    name: text('name'),
    createdByUserId: uuid('created_by_user_id').references(() => systemUsers.id, { onDelete: 'set null' }),
    createdByCredentialId: uuid('created_by_credential_id').references(() => apiCredentials.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    index('voucher_import_batches_org_created_idx').on(t.organizationId, t.createdAt),
    // Target of the vouchers' (organization_id, import_batch_id) key: a voucher's batch is its own organization's.
    uniqueIndex('voucher_import_batches_org_id_idx').on(t.organizationId, t.id),
    // Never both. The repository always sets one; either may become null when its user or key is deleted.
    check(
      'voucher_import_batches_one_creator',
      sql`num_nonnulls(${t.createdByUserId}, ${t.createdByCredentialId}) <= 1`,
    ),
    pgPolicy('tenant_manage_voucher_import_batches', {
      for: 'all',
      to: authenticatedRole,
      using: sql`${t.organizationId}::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id'))`,
    }),
  ],
);

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
    /**
     * How many non-cancelled vouchers of this kind one member may hold, counting used ones. Null is no
     * limit. Checked under the voucher's row lock in the claim/grant transaction.
     */
    perMemberLimit: integer('per_member_limit'),
    /**
     * Each customer's voucher is usable this many days from its issue, capped by `expiresAt`
     * (`VoucherTerms.use_duration_ms` on-chain). Null: every voucher expires at `expiresAt`.
     */
    validForDays: integer('valid_for_days'),
    claimedCount: integer('claimed_count').default(0).notNull(),
    status: voucherStatusEnum('status').default('DRAFT').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    metadata: jsonb('metadata').default({}),
    /** The batch it was created or last imported in (OCT-303); null when created on its own. */
    importBatchId: uuid('import_batch_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('voucher_org_code_idx').on(t.organizationId, t.code),
    index('vouchers_import_batch_idx').on(t.importBatchId),
    // Composite, so a voucher can only point at a batch of its own organization.
    foreignKey({
      name: 'vouchers_import_batch_fk',
      columns: [t.organizationId, t.importBatchId],
      foreignColumns: [voucherImportBatches.organizationId, voucherImportBatches.id],
    }),
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
    /**
     * This customer's own deadline (`voucherUseDeadline`): set when it is issued and fixed again when
     * it becomes AVAILABLE, the point the chain records its `issued_at_ms`.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('voucher_ownership_serial_idx').on(t.serialCode),
    // Serves the per-member count; the limit itself is `vouchers.per_member_limit`.
    index('voucher_ownership_voucher_member_count_idx').on(t.voucherId, t.organizationEndUserId),
    // No organization column: both sides must be the tenant's, the member and the voucher. Checking
    // the member alone would let a tenant link its own member to another organization's voucher on
    // insert (the foreign key check does not go through RLS, and `WITH CHECK` falls back to `USING`).
    pgPolicy('tenant_isolation_voucher_ownerships', {
      for: 'all',
      to: authenticatedRole,
      using: sql`exists (select 1 from ${organizationEndUsers} where ${organizationEndUsers.id} = ${t.organizationEndUserId} and ${organizationEndUsers.organizationId}::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id'))) and exists (select 1 from ${vouchers} where ${vouchers.id} = ${t.voucherId} and ${vouchers.organizationId}::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id')))`,
    }),
  ],
);

/**
 * VOUCHER APPROVAL REQUEST: one request to take a voucher live in an organization that requires
 * approval, and how it ended. A Business Developer submits it, or an API key asking for `ACTIVE`
 * (so the submitter is a user or a credential, never both). At most one is PENDING per voucher.
 */
export const voucherApprovalRequests = pgTable(
  'voucher_approval_requests',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    voucherId: uuid('voucher_id')
      .notNull()
      .references(() => vouchers.id, { onDelete: 'cascade' }),
    status: voucherApprovalStatusEnum('status').default('PENDING').notNull(),
    submittedByUserId: uuid('submitted_by_user_id').references(() => systemUsers.id, { onDelete: 'set null' }),
    submittedByCredentialId: uuid('submitted_by_credential_id').references(() => apiCredentials.id, {
      onDelete: 'set null',
    }),
    reviewedById: uuid('reviewed_by_id').references(() => systemUsers.id, { onDelete: 'set null' }),
    reason: text('reason'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).defaultNow().notNull(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  },
  (t) => [
    index('voucher_approval_requests_voucher_idx').on(t.voucherId, t.submittedAt),
    uniqueIndex('voucher_approval_requests_one_pending_idx')
      .on(t.voucherId)
      .where(sql`${t.status} = 'PENDING'`),
    // Never both. The repository always sets one; either may become null when its user or key is deleted.
    check(
      'voucher_approval_requests_one_submitter',
      sql`num_nonnulls(${t.submittedByUserId}, ${t.submittedByCredentialId}) <= 1`,
    ),
    pgPolicy('tenant_manage_voucher_approval_requests', {
      for: 'all',
      to: authenticatedRole,
      using: sql`${t.organizationId}::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id')) and exists (select 1 from ${vouchers} where ${vouchers.id} = ${t.voucherId} and ${vouchers.organizationId} = ${t.organizationId})`,
    }),
  ],
);
