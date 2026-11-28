import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { describe, expect, it } from 'vitest';
import { SYSTEM_ROLES } from '@octap/contracts';
import { eq } from 'drizzle-orm';
import { withRls } from '#infra/db/rls.js';
import { schema } from './support/db.js';

const migrations = fileURLToPath(new URL('../../db/postgres/migrations', import.meta.url));
const compat = fileURLToPath(new URL('../../../docker/postgres-init/01-supabase-compat.sql', import.meta.url));

async function removeFixture(folder: string) {
  if (dirname(resolve(folder)) !== resolve(tmpdir()) || !basename(folder).startsWith('octap-migration-')) {
    throw new Error('Refusing cleanup outside the temporary migration fixture');
  }
  await rm(folder, { recursive: true, force: true });
}

/** Runs `check` against a disposable database migrated up to and including migration `upTo`. */
async function withDatabaseAt(upTo: number, check: (client: postgres.Sql) => Promise<void>) {
  const url = new URL(process.env.DATABASE_URL!);
  const name = `octap_migration_${randomUUID().replaceAll('-', '')}_test`;
  const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
  let client: postgres.Sql | undefined;
  const folder = await mkdtemp(join(tmpdir(), 'octap-migration-'));
  try {
    await admin`create database ${admin(name)}`;
    url.pathname = `/${name}`;
    client = postgres(url.toString(), { max: 1, onnotice: () => {} });
    await client.unsafe(await readFile(compat, 'utf8'));
    await mkdir(join(folder, 'meta'));
    const journal = JSON.parse(await readFile(join(migrations, 'meta/_journal.json'), 'utf8'));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= upTo);
    for (const entry of journal.entries) {
      await copyFile(join(migrations, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    }
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    await migrate(drizzle(client), { migrationsFolder: folder });
    await check(client);
  } finally {
    await client?.end();
    // The name is generated here and this connection is the disposable integration database.
    await admin`drop database if exists ${admin(name)}`;
    await admin.end();
    await removeFixture(folder);
  }
}

describe('0012_voucher_claim_reserve_command_type', () => {
  it('moves existing paid voucher claims, and only them, to their own command type', async () => {
    await withDatabaseAt(11, async (client) => {
      const db = drizzle(client, { schema });
      const [org] =
        await client`insert into organizations (slug, name) values (${randomUUID()}, 'Legacy org') returning id`;
      await db.insert(schema.operations).values([
        {
          tenantId: org.id,
          idempotencyKey: 'claim',
          commandType: 'CREDIT_POS_REDEEM_RESERVE',
          payload: { voucherOwnershipId: 'coupon', pointsAmount: 25 },
        },
        {
          tenantId: org.id,
          idempotencyKey: 'pos',
          commandType: 'CREDIT_POS_REDEEM_RESERVE',
          payload: { pointsAmount: 25 },
        },
        { tenantId: org.id, idempotencyKey: 'free', commandType: 'VOUCHER_CLAIM', payload: {} },
      ]);

      await migrate(db, { migrationsFolder: migrations });

      const rows = await db.select().from(schema.operations);
      expect(Object.fromEntries(rows.map((row) => [row.idempotencyKey, row.commandType]))).toEqual({
        claim: 'VOUCHER_CLAIM_RESERVE',
        pos: 'CREDIT_POS_REDEEM_RESERVE',
        free: 'VOUCHER_CLAIM',
      });
    });
  });
});

describe('0014_system_user_roles', () => {
  it('preserves legacy admins, regular users, identities and organization roles on upgrade', async () => {
    await withDatabaseAt(13, async (client) => {
      const adminId = randomUUID();
      const userId = randomUUID();
      const defaultId = randomUUID();
      await client`insert into system_users (id, email, full_name, is_super_admin, metadata) values
        (${adminId}, 'admin@example.com', 'Existing admin', true, '{"preserve":true}'::jsonb),
        (${userId}, 'user@example.com', 'Existing user', false, '{}'::jsonb)`;
      await client`insert into system_users (id, email, full_name) values (${defaultId}, 'default@example.com', 'Default user')`;
      const db = drizzle(client, { schema });
      const [org] =
        await client`insert into organizations (slug, name) values (${randomUUID()}, 'Legacy org') returning id`;
      await db.insert(schema.organizationMemberships).values([
        { organizationId: org.id, systemUserId: adminId, role: 'OWNER' },
        { organizationId: org.id, systemUserId: userId, role: 'MANAGER' },
      ]);

      await migrate(db, { migrationsFolder: migrations });

      const rows = await db.select().from(schema.systemUsers);
      expect(Object.fromEntries(rows.map((row) => [row.id, row.systemRole]))).toEqual({
        [adminId]: 'SYSTEM_ADMIN',
        [userId]: 'SYSTEM_USER',
        [defaultId]: 'SYSTEM_USER',
      });
      expect(rows.find((row) => row.id === adminId)).toMatchObject({
        fullName: 'Existing admin',
        email: 'admin@example.com',
        metadata: { preserve: true },
      });
      const memberships = await db.select().from(schema.organizationMemberships);
      expect(Object.fromEntries(memberships.map((row) => [row.systemUserId, row.role]))).toEqual({
        [adminId]: 'OWNER',
        [userId]: 'MANAGER',
      });
      const oldColumn =
        await client`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'system_users' and column_name = 'is_super_admin'`;
      expect(oldColumn).toHaveLength(0);
      const labels =
        await client`select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typname = 'system_user_role' order by e.enumsortorder`;
      expect(labels.map((row) => row.enumlabel)).toEqual([...SYSTEM_ROLES]);
      // The migration journal makes running the migrator again safe.
      await migrate(db, { migrationsFolder: migrations });
      expect((await db.select().from(schema.systemUsers)).map((row) => row.id).sort()).toEqual(
        [adminId, userId, defaultId].sort(),
      );
    });
  });

  it('defaults new users to SYSTEM_USER and rejects legacy, null and unknown roles', async () => {
    await withDatabaseAt(14, async (client) => {
      const [created] =
        await client`insert into system_users (email, full_name) values ('new@example.com', 'New user') returning system_role`;
      expect(created.system_role).toBe('SYSTEM_USER');
      for (const role of ['SUPER_ADMIN', 'ADMIN', 'USER', 'OWNER', 'unknown', null]) {
        await expect(
          client`insert into system_users (email, full_name, system_role) values (${`${role}@example.com`}, 'Invalid user', ${role})`,
        ).rejects.toThrow();
      }
    });
  });

  it('does not allow authenticated users to promote themselves or read another user', async () => {
    await withDatabaseAt(14, async (client) => {
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: migrations });
      const [user, admin] = await db
        .insert(schema.systemUsers)
        .values([
          { email: 'user@example.com', fullName: 'User' },
          { email: 'admin@example.com', fullName: 'Admin', systemRole: 'SYSTEM_ADMIN' },
        ])
        .returning();
      await withRls(db, { userId: user.id }, async (tx) => {
        expect(await tx.select().from(schema.systemUsers)).toMatchObject([{ id: user.id, systemRole: 'SYSTEM_USER' }]);
        expect(
          await tx
            .update(schema.systemUsers)
            .set({ systemRole: 'SYSTEM_ADMIN' })
            .where(eq(schema.systemUsers.id, user.id))
            .returning(),
        ).toEqual([]);
      });
      expect((await db.select().from(schema.systemUsers).where(eq(schema.systemUsers.id, user.id)))[0].systemRole).toBe(
        'SYSTEM_USER',
      );
      expect(
        (await db.select().from(schema.systemUsers).where(eq(schema.systemUsers.id, admin.id)))[0].systemRole,
      ).toBe('SYSTEM_ADMIN');
    });
  });
});

describe('0019_earn_purchase_amount', () => {
  it('moves earn commands to the purchase payload and leaves other commands alone', async () => {
    await withDatabaseAt(18, async (client) => {
      const db = drizzle(client, { schema });
      const [org] =
        await client`insert into organizations (slug, name) values (${randomUUID()}, 'Queued org') returning id`;
      const insert = (commandType: string, key: string, payload: Record<string, unknown>) =>
        db.insert(schema.operations).values({
          tenantId: org.id,
          commandType,
          idempotencyKey: key,
          payload,
          payloadHash: 'old-hash',
          status: 'PENDING',
        });
      await insert('CREDIT_EARN_CHAIN_SUBMIT', 'earn', { loyaltyTransactionId: 'tx', pointsAmount: 100000 });
      await insert('POS_REDEEM_RESERVE', 'pos', { organizationEndUserId: 'member', pointsAmount: 40 });

      await migrate(db, { migrationsFolder: migrations });

      const rows = await db.select().from(schema.operations);
      expect(rows.find((row) => row.idempotencyKey === 'earn')).toMatchObject({
        payload: { loyaltyTransactionId: 'tx', purchaseAmount: 100000 },
        payloadHash: null,
      });
      expect(rows.find((row) => row.idempotencyKey === 'pos')).toMatchObject({
        payload: { organizationEndUserId: 'member', pointsAmount: 40 },
        payloadHash: 'old-hash',
      });
    });
  });
});

describe('0033_voucher_approval_snapshot_and_actors', () => {
  it("backfills a batch voucher's creator and an approved voucher's activator, and leaves the rest unknown", async () => {
    await withDatabaseAt(32, async (client) => {
      const [org] = await client`insert into organizations (slug, name) values (${randomUUID()}, 'Org') returning id`;
      const [developer] =
        await client`insert into system_users (email, full_name) values ('bd@example.com', 'BD') returning id`;
      const [owner] =
        await client`insert into system_users (email, full_name) values ('owner@example.com', 'Owner') returning id`;
      const [batch] = await client`insert into voucher_import_batches (organization_id, source, created_by_user_id)
        values (${org.id}, 'CONSOLE', ${developer.id}) returning id`;
      const voucher = async (code: string, extra: { batch?: string; publishStatus?: string } = {}) =>
        (
          await client`insert into vouchers (organization_id, code, title, import_batch_id, publish_status)
            values (${org.id}, ${code}, ${code}, ${extra.batch ?? null}, ${extra.publishStatus ?? 'NOT_PUBLISHED'})
            returning id`
        )[0].id as string;
      await voucher('IMPORTED', { batch: batch.id });
      const approved = await voucher('APPROVED', { publishStatus: 'PUBLISHED' });
      const rejected = await voucher('REJECTED');
      const reviewedAt = new Date('2026-11-20T10:00:00Z');
      for (const [id, status] of [
        [approved, 'APPROVED'],
        [rejected, 'REJECTED'],
      ] as const) {
        await client`insert into voucher_approval_requests
          (organization_id, voucher_id, status, submitted_by_user_id, reviewed_by_id, reviewed_at)
          values (${org.id}, ${id}, ${status}, ${developer.id}, ${owner.id}, ${reviewedAt.toISOString()})`;
      }

      await migrate(drizzle(client), { migrationsFolder: migrations });

      const rows = await client`select code, created_by_user_id, created_by_credential_id, activated_by_user_id,
        activated_at from vouchers order by code`;
      expect(
        rows.map((r) => ({ ...r, activated_at: r.activated_at && new Date(r.activated_at).toISOString() })),
      ).toEqual([
        {
          code: 'APPROVED',
          created_by_user_id: null,
          created_by_credential_id: null,
          activated_by_user_id: owner.id,
          activated_at: reviewedAt.toISOString(),
        },
        {
          code: 'IMPORTED',
          created_by_user_id: developer.id,
          created_by_credential_id: null,
          activated_by_user_id: null,
          activated_at: null,
        },
        {
          code: 'REJECTED',
          created_by_user_id: null,
          created_by_credential_id: null,
          activated_by_user_id: null,
          activated_at: null,
        },
      ]);
      const [request] = await client`select snapshot from voucher_approval_requests where voucher_id = ${approved}`;
      expect(request.snapshot).toBeNull();
    });
  });
});

describe('0044_licensing', () => {
  it('replaces the billing tables, seeds the plans, and gives working organizations Growth for 12 months', async () => {
    await withDatabaseAt(43, async (client) => {
      const org = async (status: string) =>
        (
          await client`insert into organizations (slug, name, status) values (${randomUUID()}, ${status}, ${status})
            returning id`
        )[0].id as string;
      const active = await org('ACTIVE');
      const suspended = await org('SUSPENDED');
      await org('ARCHIVED');
      // Gets the trial when it is approved, like any new organization; a Growth license now would hide it.
      await org('PENDING_APPROVAL');

      await migrate(drizzle(client), { migrationsFolder: migrations });

      const plans = await client`select tier, monthly_price_vnd, term_months_allowed, duration_days, purchasable
        from license_plans order by monthly_price_vnd, tier`;
      expect(plans.map((p) => ({ ...p }))).toEqual([
        { tier: 'TRIAL', monthly_price_vnd: 0, term_months_allowed: [], duration_days: 14, purchasable: false },
        { tier: 'ENTERPRISE', monthly_price_vnd: 0, term_months_allowed: [], duration_days: null, purchasable: false },
        {
          tier: 'STARTER',
          monthly_price_vnd: 990000,
          term_months_allowed: [3, 6, 12],
          duration_days: null,
          purchasable: true,
        },
        {
          tier: 'GROWTH',
          monthly_price_vnd: 2990000,
          term_months_allowed: [3, 6, 12],
          duration_days: null,
          purchasable: true,
        },
      ]);
      const licenses = await client`select organization_id, tier, source, entitlements,
        ends_at = starts_at + interval '12 months' as twelve_months from licenses order by organization_id`;
      expect(licenses.map((l) => l.organization_id).sort()).toEqual([active, suspended].sort());
      for (const license of licenses) {
        expect(license).toMatchObject({ tier: 'GROWTH', source: 'MIGRATION', twelve_months: true });
        expect(license.entitlements.features).toContain('mcp');
      }
      const [old] = await client`select to_regclass('public.subscriptions') as subscriptions,
        to_regclass('public.billing_plans') as plans`;
      expect(old).toEqual({ subscriptions: null, plans: null });
      // The catalogue is platform-wide: RLS on, no policy, so a tenant can't read or change it.
      const [rls] = await client`select relrowsecurity from pg_class where relname = 'license_plans'`;
      expect(rls.relrowsecurity).toBe(true);
      const [policies] = await client`select count(*)::int as n from pg_policies where tablename = 'license_plans'`;
      expect(policies.n).toBe(0);
    });
  });
});
