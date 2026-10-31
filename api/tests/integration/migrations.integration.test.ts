import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { describe, expect, it } from 'vitest';
import { schema, seedOrganization } from './support/db.js';

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
      const org = await seedOrganization(db);
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
