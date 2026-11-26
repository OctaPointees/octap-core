import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { authenticatedRole } from 'drizzle-orm/supabase';
import { apiCredentials, organizations } from './organizations.schema.js';
import { organizationEndUsers } from './members.schema.js';
import { loyaltyTxStatusEnum, loyaltyTxTypeEnum } from './credits.schema.js';

const tenantPolicy = (organizationId: unknown) =>
  sql`${organizationId}::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id'))`;

/**
 * SANDBOX BALANCE (OCT-297): a member's points as seen by the organization's sandbox keys. Its own
 * table, not a flag on `credit_ownerships`, so nothing a sandbox key does can reach a real balance,
 * and no live read needs to filter sandbox rows out. Starts at zero; only sandbox earns fill it.
 */
export const sandboxCreditBalances = pgTable(
  'sandbox_credit_balances',
  {
    organizationEndUserId: uuid('organization_end_user_id')
      .primaryKey()
      .references(() => organizationEndUsers.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    confirmedBalance: bigint('confirmed_balance', { mode: 'number' }).default(0).notNull(),
    pendingRedemption: bigint('pending_redemption', { mode: 'number' }).default(0).notNull(),
    lifetimeEarned: bigint('lifetime_earned', { mode: 'number' }).default(0).notNull(),
    lifetimeRedeemed: bigint('lifetime_redeemed', { mode: 'number' }).default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check('sandbox_balance_not_negative', sql`${t.confirmedBalance} >= 0 and ${t.pendingRedemption} >= 0`),
    check('sandbox_hold_covered', sql`${t.pendingRedemption} <= ${t.confirmedBalance}`),
    pgPolicy('tenant_manage_sandbox_credit_balances', {
      for: 'all',
      to: authenticatedRole,
      using: tenantPolicy(t.organizationId),
    }),
  ],
);

/**
 * SANDBOX TRANSACTION (OCT-297): an earn or redemption made with a sandbox key. Never dispatched to
 * the chain: `digest` is a synthetic `sandbox_…` id, so it can never be mistaken for, or looked up
 * as, a Sui transaction. Idempotent on (organization, `idempotencyKey`) like the live ledger, with
 * `payloadHash` to refuse a changed request under a used key.
 */
export const sandboxLoyaltyTransactions = pgTable(
  'sandbox_loyalty_transactions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    organizationEndUserId: uuid('organization_end_user_id')
      .notNull()
      .references(() => organizationEndUsers.id, { onDelete: 'cascade' }),
    credentialId: uuid('credential_id')
      .notNull()
      .references(() => apiCredentials.id, { onDelete: 'cascade' }),
    transactionType: loyaltyTxTypeEnum('transaction_type').notNull(),
    status: loyaltyTxStatusEnum('status').notNull(),
    pointsAmount: bigint('points_amount', { mode: 'number' }).notNull(),
    purchaseAmount: bigint('purchase_amount', { mode: 'number' }),
    idempotencyKey: text('idempotency_key').notNull(),
    payloadHash: text('payload_hash').notNull(),
    receiptReference: text('receipt_reference'),
    metadata: jsonb('metadata').default({}),
    digest: text('digest').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('sandbox_loyalty_tx_org_idempotency_idx').on(t.organizationId, t.idempotencyKey),
    index('sandbox_loyalty_tx_member_created_idx').on(t.organizationEndUserId, t.createdAt),
    check('sandbox_tx_type', sql`${t.transactionType} in ('EARN', 'REDEEM')`),
    check('sandbox_tx_digest', sql`${t.digest} like 'sandbox\\_%'`),
    pgPolicy('tenant_manage_sandbox_loyalty_transactions', {
      for: 'all',
      to: authenticatedRole,
      using: tenantPolicy(t.organizationId),
    }),
  ],
);
