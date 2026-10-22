import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  index,
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
import { organizationEndUsers } from './members.schema.js';
import { organizationMemberships } from './auth.schema.js';

export const loyaltyTxTypeEnum = pgEnum('loyalty_tx_type', [
  'EARN',
  'REDEEM',
  'REVERSAL',
  'TRANSFER',
  'EXPIRY',
  'ADJUSTMENT',
]);

export const loyaltyTxStatusEnum = pgEnum('loyalty_tx_status', [
  'PENDING',
  'CONFIRMED',
  'FAILED',
  'REVERSED',
]);

export const blockchainTxStatusEnum = pgEnum('blockchain_tx_status', [
  'PENDING',
  'SUBMITTED',
  'CONFIRMED',
  'FAILED',
]);

/**
 * BLOCKCHAIN TRANSACTION: Audit trail of transactions dispatched to the Sui blockchain.
 */
export const blockchainTransactions = pgTable('blockchain_transactions', {
  id: uuid('id').defaultRandom().primaryKey(),
  digest: text('digest').notNull().unique(),
  checkpoint: bigint('checkpoint', { mode: 'number' }),
  sender: text('sender').notNull(),
  status: blockchainTxStatusEnum('status').default('PENDING').notNull(),
  gasUsed: bigint('gas_used', { mode: 'number' }),
  errorMessage: text('error_message'),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * CREDIT OWNERSHIP: Represents point balance, tier counters, and on-chain credit account reference.
 */
export const creditOwnerships = pgTable(
  'credit_ownerships',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationEndUserId: uuid('organization_end_user_id')
      .notNull()
      .unique()
      .references(() => organizationEndUsers.id, { onDelete: 'cascade' }),
    suiCreditAccountId: text('sui_credit_account_id'),
    confirmedBalance: bigint('confirmed_balance', { mode: 'number' }).default(0).notNull(),
    pendingEarn: bigint('pending_earn', { mode: 'number' }).default(0).notNull(),
    pendingRedemption: bigint('pending_redemption', { mode: 'number' }).default(0).notNull(),
    lifetimeEarned: bigint('lifetime_earned', { mode: 'number' }).default(0).notNull(),
    lifetimeRedeemed: bigint('lifetime_redeemed', { mode: 'number' }).default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
);

/**
 * LOYALTY TRANSACTION: Point operations (earn/redeem/reversal) created by organization members
 * and dispatched to blockchain.
 */
export const loyaltyTransactions = pgTable(
  'loyalty_transactions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    organizationEndUserId: uuid('organization_end_user_id')
      .notNull()
      .references(() => organizationEndUsers.id, { onDelete: 'cascade' }),
    createdByMembershipId: uuid('created_by_membership_id').references(
      () => organizationMemberships.id,
      { onDelete: 'set null' },
    ),
    blockchainTransactionId: uuid('blockchain_transaction_id').references(
      () => blockchainTransactions.id,
      { onDelete: 'set null' },
    ),
    transactionType: loyaltyTxTypeEnum('transaction_type').notNull(),
    pointsAmount: bigint('points_amount', { mode: 'number' }).notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    receiptReference: text('receipt_reference'),
    status: loyaltyTxStatusEnum('status').default('PENDING').notNull(),
    /**
     * Set only on a REVERSAL row, pointing back at the EARN/REDEEM it reverses. Unique (not
     * just indexed) so the database itself rejects a second reversal of the same original,
     * even under a concurrent retry — the app-level status check in ReversalService is the
     * friendly error path, this is the backstop.
     */
    reversesTransactionId: uuid('reverses_transaction_id')
      .unique()
      .references((): AnyPgColumn => loyaltyTransactions.id),
    metadata: jsonb('metadata').default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('loyalty_tx_org_idempotency_idx').on(t.organizationId, t.idempotencyKey),
    pgPolicy('tenant_isolation_loyalty_transactions', {
      for: 'all',
      to: authenticatedRole,
      using: sql`${t.organizationId}::text = coalesce(current_setting('app.current_tenant_id', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id'))`,
    }),
  ],
);

/**
 * CREDIT BUCKET: PostgreSQL mirror of `credit_account.move`'s `Bucket` — one per confirmed EARN,
 * expiring at the chain's own `bucket_expires_at_ms`. `remaining` is what redemptions (FIFO,
 * nearest expiry first, same as `redeem` on-chain) and reversals haven't consumed yet; an expiry
 * sweep forfeits it. Points with no bucket (reversed-redeem add-backs, pre-bucket history) never
 * expire here.
 */
export const creditBuckets = pgTable(
  'credit_buckets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    creditOwnershipId: uuid('credit_ownership_id')
      .notNull()
      .references(() => creditOwnerships.id, { onDelete: 'cascade' }),
    earnTransactionId: uuid('earn_transaction_id')
      .notNull()
      .unique()
      .references(() => loyaltyTransactions.id, { onDelete: 'cascade' }),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    remaining: bigint('remaining', { mode: 'number' }).notNull(),
    expiresAtMs: bigint('expires_at_ms', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('credit_buckets_ownership_expiry_idx').on(t.creditOwnershipId, t.expiresAtMs)],
);
