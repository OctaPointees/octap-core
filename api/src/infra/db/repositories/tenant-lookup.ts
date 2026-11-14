import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '../postgres.provider.js';
import { withTenant } from '../rls.js';
import { creditOwnerships, loyaltyTransactions } from '../schema/credits.schema.js';
import { organizationEndUsers } from '../schema/members.schema.js';
import { operations } from '../schema/operations.schema.js';
import { vouchers, voucherOwnerships } from '../schema/rewards.schema.js';
import { webhookDeliveries, webhookEndpoints } from '../schema/webhooks.schema.js';

/**
 * Which organization a row belongs to, for repository methods that start from an id alone (worker
 * and indexer callbacks). These are the only reads that run before the RLS context exists: each
 * reads the one organization column, and the method's real work then runs under `withTenant` for
 * that organization.
 */
export const tenantOf = {
  voucher: (db: DrizzleDb, id: string) =>
    one(db.select({ organizationId: vouchers.organizationId }).from(vouchers).where(eq(vouchers.id, id))),
  voucherOwnership: (db: DrizzleDb, id: string) =>
    one(
      db
        .select({ organizationId: vouchers.organizationId })
        .from(voucherOwnerships)
        .innerJoin(vouchers, eq(vouchers.id, voucherOwnerships.voucherId))
        .where(eq(voucherOwnerships.id, id)),
    ),
  member: (db: DrizzleDb, organizationEndUserId: string) =>
    one(
      db
        .select({ organizationId: organizationEndUsers.organizationId })
        .from(organizationEndUsers)
        .where(eq(organizationEndUsers.id, organizationEndUserId)),
    ),
  creditOwnership: (db: DrizzleDb, id: string) =>
    one(
      db
        .select({ organizationId: organizationEndUsers.organizationId })
        .from(creditOwnerships)
        .innerJoin(organizationEndUsers, eq(organizationEndUsers.id, creditOwnerships.organizationEndUserId))
        .where(eq(creditOwnerships.id, id)),
    ),
  loyaltyTransaction: (db: DrizzleDb, id: string) =>
    one(
      db
        .select({ organizationId: loyaltyTransactions.organizationId })
        .from(loyaltyTransactions)
        .where(eq(loyaltyTransactions.id, id)),
    ),
  operation: (db: DrizzleDb, id: string) =>
    one(db.select({ organizationId: operations.tenantId }).from(operations).where(eq(operations.id, id))),
  webhookEndpoint: (db: DrizzleDb, id: string) =>
    one(
      db
        .select({ organizationId: webhookEndpoints.organizationId })
        .from(webhookEndpoints)
        .where(eq(webhookEndpoints.id, id)),
    ),
  webhookDelivery: (db: DrizzleDb, id: string) =>
    one(
      db
        .select({ organizationId: webhookDeliveries.organizationId })
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, id)),
    ),
};

async function one(query: PromiseLike<{ organizationId: string }[]>): Promise<string | undefined> {
  const [row] = await query;
  return row?.organizationId;
}

/**
 * Looks up the organization with `lookup`, then runs `work` under its RLS context, in one transaction
 * (one pooled connection). When the row is gone there is no organization: `missing` answers instead.
 */
export function withTenantOf<T>(
  db: DrizzleDb,
  lookup: (db: DrizzleDb) => Promise<string | undefined>,
  work: (tx: DrizzleDb, organizationId: string) => Promise<T>,
  missing: (db: DrizzleDb) => T | Promise<T>,
): Promise<T> {
  return db.transaction(async (outer) => {
    const organizationId = await lookup(outer);
    if (!organizationId) return missing(outer);
    return withTenant(outer, organizationId, (tx) => work(tx, organizationId));
  });
}

/**
 * `withTenantOf` where a missing row keeps the method's own answer: with no row there is no
 * organization and nothing of anyone's to protect, so `work` runs as before on the caller's
 * connection and returns whatever it did (null, "already settled", …).
 */
export function inTenantOf<T>(
  db: DrizzleDb,
  lookup: (db: DrizzleDb) => Promise<string | undefined>,
  work: (tx: DrizzleDb) => Promise<T>,
): Promise<T> {
  return withTenantOf(
    db,
    lookup,
    (tx) => work(tx),
    (outer) => work(outer),
  );
}
