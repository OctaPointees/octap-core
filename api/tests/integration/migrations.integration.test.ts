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
