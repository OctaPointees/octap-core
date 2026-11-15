import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { asOwnRole, withTenant } from '#infra/db/rls.js';
import type { DrizzleDb } from '#infra/db/postgres.provider.js';
import { CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import { RewardsRepository } from '#infra/db/repositories/rewards.repository.js';
import { WebhooksRepository } from '#infra/db/repositories/webhooks.repository.js';
import { ApiCredentialsRepository } from '#infra/db/repositories/api-credentials.repository.js';
import {
  connectTestDb,
  insertLoyaltyTransaction,
  resetDb,
  schema,
  seedCredential,
  seedMember,
  seedOrganization,
  setOwnership,
} from '../support/db.js';

/**
 * OCT-289: Postgres itself, not the application's WHERE clauses, keeps one organization's rows from
 * another. Every query here runs under `withTenant` with no WHERE on the organization at all.
 */
const { db, client } = connectTestDb();

type Seeded = Awaited<ReturnType<typeof seedTenant>>;
let a: Seeded;
let b: Seeded;

/** One organization with a row in every tenant table OCT-289 covers. */
async function seedTenant(label: string) {
  const org = await seedOrganization(db);
  const { memberId } = await seedMember(db, org.id);
  const ownership = await setOwnership(db, memberId, { confirmedBalance: 100 });
  const earn = await insertLoyaltyTransaction(db, {
    organizationId: org.id,
    organizationEndUserId: memberId,
    transactionType: 'EARN',
    pointsAmount: 100,
    idempotencyKey: `earn-${label}`,
    status: 'CONFIRMED',
  });
  const [bucket] = await db
    .insert(schema.creditBuckets)
    .values({
      creditOwnershipId: ownership.id,
      earnTransactionId: earn.id,
      amount: 100,
      remaining: 100,
      expiresAtMs: 0,
    })
    .returning();
  const [voucher] = await db
    .insert(schema.vouchers)
    .values({ organizationId: org.id, code: `CODE-${label}`, title: `Voucher ${label}` })
    .returning();
  const [held] = await db
    .insert(schema.voucherOwnerships)
    .values({ voucherId: voucher.id, organizationEndUserId: memberId, serialCode: `SERIAL-${label}` })
    .returning();
  const { credential } = await seedCredential(db, org.id);
  const [endpoint] = await db
    .insert(schema.webhookEndpoints)
    .values({ organizationId: org.id, url: `https://${label}.example.com/hook`, secret: 'secret' })
    .returning();
  const [delivery] = await db
    .insert(schema.webhookDeliveries)
    .values({ organizationId: org.id, endpointId: endpoint.id, eventType: 'test', payload: {} })
    .returning();
  const [operation] = await db
    .insert(schema.operations)
    .values({ tenantId: org.id, idempotencyKey: `op-${label}`, commandType: 'TEST', payload: {} })
    .returning();
  return {
    orgId: org.id,
    memberId,
    ids: {
      creditOwnerships: ownership.id,
      creditBuckets: bucket.id,
      loyaltyTransactions: earn.id,
      vouchers: voucher.id,
      voucherOwnerships: held.id,
      apiCredentials: credential.id,
      webhookEndpoints: endpoint.id,
      webhookDeliveries: delivery.id,
      operations: operation.id,
    },
  };
}

const TABLES: Record<keyof Seeded['ids'], PgTable & { id: unknown }> = {
  creditOwnerships: schema.creditOwnerships,
  creditBuckets: schema.creditBuckets,
  loyaltyTransactions: schema.loyaltyTransactions,
  vouchers: schema.vouchers,
  voucherOwnerships: schema.voucherOwnerships,
  apiCredentials: schema.apiCredentials,
  webhookEndpoints: schema.webhookEndpoints,
  webhookDeliveries: schema.webhookDeliveries,
  operations: schema.operations,
};

/** Every row of `table` the tenant role can see: no WHERE, only RLS decides. */
const visibleIds = (tx: DrizzleDb, table: PgTable & { id: unknown }) =>
  tx
    .select({ id: (table as unknown as { id: never }).id })
    .from(table)
    .then((rows) => rows.map((row) => (row as { id: string }).id));

/** Postgres refuses a row its policy does not allow: `42501`, "new row violates row-level security". */
const RLS_REJECTED = { cause: { code: '42501', message: expect.stringMatching(/row-level security/) } };

const currentUser = async (tx: DrizzleDb) =>
  (await tx.execute<{ user: string }>(sql`select current_user as "user"`))[0].user;

beforeEach(async () => {
  await resetDb(client);
  a = await seedTenant('a');
  b = await seedTenant('b');
});

afterAll(async () => {
  await client.end();
});

describe('RLS tenant isolation', () => {
  it.each(Object.keys(TABLES) as (keyof Seeded['ids'])[])(
    '%s: a tenant sees its own row and never the other organization’s',
    async (name) => {
      const seenByA = await withTenant(db, a.orgId, (tx) => visibleIds(tx, TABLES[name]));
      const seenByB = await withTenant(db, b.orgId, (tx) => visibleIds(tx, TABLES[name]));
      expect(seenByA).toEqual([a.ids[name]]);
      expect(seenByB).toEqual([b.ids[name]]);
    },
  );

  it('a tenant cannot change or delete another organization’s rows either', async () => {
    const changed = await withTenant(db, a.orgId, (tx) =>
      tx.update(schema.vouchers).set({ title: 'hijacked' }).returning({ id: schema.vouchers.id }),
    );
    expect(changed.map((row) => row.id)).toEqual([a.ids.vouchers]);
    const deleted = await withTenant(db, a.orgId, (tx) =>
      tx.delete(schema.voucherOwnerships).returning({ id: schema.voucherOwnerships.id }),
    );
    expect(deleted.map((row) => row.id)).toEqual([a.ids.voucherOwnerships]);
    const [untouched] = await db
      .select()
      .from(schema.vouchers)
      .where(sql`${schema.vouchers.id} = ${b.ids.vouchers}`);
    expect(untouched.title).toBe('Voucher b');
  });

  it('a tenant cannot insert a row for another organization', async () => {
    await expect(
      withTenant(db, a.orgId, (tx) =>
        tx.insert(schema.vouchers).values({ organizationId: b.orgId, code: 'SNEAKY', title: 'Sneaky' }),
      ),
    ).rejects.toMatchObject(RLS_REJECTED);
    await expect(
      withTenant(db, a.orgId, (tx) => tx.insert(schema.creditOwnerships).values({ organizationEndUserId: b.memberId })),
    ).rejects.toMatchObject(RLS_REJECTED);
  });
});

describe('withTenant inside a caller transaction', () => {
  it('leaves the caller’s role as it found it, so the caller can still read organizations', async () => {
    await db.transaction(async (outer) => {
      expect(await currentUser(outer)).toBe('postgres');
      const inside = await withTenant(outer, a.orgId, async (tx) => ({
        user: await currentUser(tx),
        organizations: await visibleIds(tx, schema.organizations as never),
      }));
      // The tenant role cannot see organizations at all (their policy is membership-based).
      expect(inside).toEqual({ user: 'authenticated', organizations: [] });
      expect(await currentUser(outer)).toBe('postgres');
      expect(await visibleIds(outer, schema.organizations as never)).toHaveLength(2);
      expect(await visibleIds(outer, schema.vouchers)).toHaveLength(2);
    });
  });

  it('a failed block rolls its settings back with its savepoint', async () => {
    await db.transaction(async (outer) => {
      await expect(
        withTenant(outer, a.orgId, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await currentUser(outer)).toBe('postgres');
    });
  });

  it('asOwnRole steps out for one check and back into the tenant', async () => {
    await withTenant(db, a.orgId, async (tx) => {
      const organizations = await asOwnRole(tx, (own) => visibleIds(own, schema.organizations as never));
      expect(organizations).toHaveLength(2);
      expect(await currentUser(tx)).toBe('authenticated');
      expect(await visibleIds(tx, schema.vouchers)).toEqual([a.ids.vouchers]);
    });
  });

  it('a failed asOwnRole check leaves the block in the tenant role', async () => {
    await withTenant(db, a.orgId, async (tx) => {
      await expect(
        asOwnRole(tx, async () => {
          throw new Error('inactive');
        }),
      ).rejects.toThrow('inactive');
      expect(await currentUser(tx)).toBe('authenticated');
      expect(await visibleIds(tx, schema.vouchers)).toEqual([a.ids.vouchers]);
    });
  });
});

describe('worker callbacks that start from an id run under that row’s own organization', () => {
  it('still find their row, and a missing id keeps its old answer', async () => {
    const credits = new CreditsRepository(db);
    const webhooks = new WebhooksRepository(db);
    expect((await credits.getLoyaltyTransactionById(b.ids.loyaltyTransactions))?.id).toBe(b.ids.loyaltyTransactions);
    expect((await webhooks.findEndpointById(a.ids.webhookEndpoints))?.id).toBe(a.ids.webhookEndpoints);
    expect(await webhooks.findEndpointById('00000000-0000-0000-0000-000000000000')).toBeUndefined();
  });
});

describe('request paths pass the authenticated organization, so RLS refuses another organization’s row', () => {
  it('reads with the right organization find the row', async () => {
    const rewards = new RewardsRepository(db);
    const credits = new CreditsRepository(db);
    expect((await rewards.findVoucherById(b.orgId, b.ids.vouchers))?.id).toBe(b.ids.vouchers);
    expect((await rewards.listOwnershipsByMember(b.orgId, b.memberId)).map((o) => o.id)).toEqual([
      b.ids.voucherOwnerships,
    ]);
    expect((await credits.getCreditOwnershipByEndUserId(a.orgId, a.memberId))?.id).toBe(a.ids.creditOwnerships);
    expect((await credits.getOrCreateCreditOwnership(a.orgId, a.memberId)).id).toBe(a.ids.creditOwnerships);
    expect(await credits.findBeneficiaryAddress(a.orgId, a.memberId)).not.toBeNull();
  });

  it('reads with another organization see nothing', async () => {
    const rewards = new RewardsRepository(db);
    const credits = new CreditsRepository(db);
    expect(await rewards.findVoucherById(a.orgId, b.ids.vouchers)).toBeUndefined();
    expect(await rewards.listOwnershipsByMember(a.orgId, b.memberId)).toEqual([]);
    expect(await credits.getCreditOwnershipByEndUserId(a.orgId, b.memberId)).toBeUndefined();
    expect(await credits.findBeneficiaryAddress(a.orgId, b.memberId)).toBeNull();
  });

  it('writes with another organization change nothing, or are refused', async () => {
    const credits = new CreditsRepository(db);
    const webhooks = new WebhooksRepository(db);
    expect(await webhooks.rotateEndpointSecret(a.orgId, b.ids.webhookEndpoints, 'stolen')).toBeUndefined();
    expect(await webhooks.setEndpointStatus(a.orgId, b.ids.webhookEndpoints, 'DISABLED')).toBeUndefined();
    expect(await webhooks.resetForReplay(a.orgId, b.ids.webhookDeliveries)).toBeUndefined();
    const [endpoint] = await db
      .select()
      .from(schema.webhookEndpoints)
      .where(sql`${schema.webhookEndpoints.id} = ${b.ids.webhookEndpoints}`);
    expect(endpoint).toMatchObject({ secret: 'secret', status: 'ACTIVE' });

    // B's member has a credit account already, which A cannot see: creating a second one is refused.
    await expect(credits.getOrCreateCreditOwnership(a.orgId, b.memberId)).rejects.toMatchObject(RLS_REJECTED);
  });

  it('an organization-scoped read cannot reach another organization’s row', async () => {
    const credits = new CreditsRepository(db);
    const webhooks = new WebhooksRepository(db);
    const keys = new ApiCredentialsRepository(db);
    expect(await credits.findTransactionByIdForOrganization(a.orgId, b.ids.loyaltyTransactions)).toBeUndefined();
    expect(await webhooks.findDeliveryForOrganization(a.orgId, b.ids.webhookDeliveries)).toBeUndefined();
    expect(await db.transaction((tx) => keys.findForUpdate(tx, a.orgId, b.ids.apiCredentials))).toBeUndefined();
  });
});
