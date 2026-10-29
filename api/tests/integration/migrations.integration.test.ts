import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { describe, expect, it } from 'vitest';

const migrations = fileURLToPath(new URL('../../db/postgres/migrations', import.meta.url));
const compat = fileURLToPath(new URL('../../../docker/postgres-init/01-supabase-compat.sql', import.meta.url));

async function removeFixture(folder: string) {
  if (dirname(resolve(folder)) !== resolve(tmpdir()) || !basename(folder).startsWith('octap-migration-')) {
    throw new Error('Refusing cleanup outside the temporary migration fixture');
  }
  await rm(folder, { recursive: true, force: true });
}

describe('dev / voucher-branch migration reconciliation', () => {
  it.each(['fresh', 'dev', 'legacy-voucher'] as const)(
    'migrates a %s database with both indexes intact',
    async (baseline) => {
      const url = new URL(process.env.DATABASE_URL!);
      const name = `octap_migration_${randomUUID().replaceAll('-', '')}_test`;
      const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
      let client: ReturnType<typeof postgres> | undefined;
      let folder: string | undefined;
      try {
        await admin`create database ${admin(name)}`;
        url.pathname = `/${name}`;
        client = postgres(url.toString(), { max: 1, onnotice: () => {} });
        await client.unsafe(await readFile(compat, 'utf8'));
        if (baseline !== 'fresh') {
          folder = await mkdtemp(join(tmpdir(), 'octap-migration-'));
          await mkdir(join(folder, 'meta'));
          const journal = JSON.parse(await readFile(join(migrations, 'meta/_journal.json'), 'utf8'));
          journal.entries = journal.entries.filter(
            (entry: { idx: number }) => entry.idx <= (baseline === 'dev' ? 10 : 9),
          );
          for (const entry of journal.entries) {
            await copyFile(join(migrations, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
          }
          if (baseline === 'legacy-voucher') {
            const tag = '0010_legacy_voucher_claim_reservation';
            // This branch's old 0010 was applied after dev's 0010 timestamp. Drizzle skips the
            // earlier migration, so 0011 must also create the missing operation index safely.
            journal.entries.push({ idx: 10, version: '7', when: 1793264922092, tag, breakpoints: true });
            const sql = (await readFile(join(migrations, '0011_voucher_claim_reservations.sql'), 'utf8'))
              .split('--> statement-breakpoint')
              .slice(0, 2)
              .join('--> statement-breakpoint');
            await writeFile(join(folder, `${tag}.sql`), sql);
          }
          await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
          await migrate(drizzle(client), { migrationsFolder: folder });
        }
        await migrate(drizzle(client), { migrationsFolder: migrations });
        // Re-running is also harmless for previously migrated environments.
        await migrate(drizzle(client), { migrationsFolder: migrations });
        const indexes = await client<{ indexname: string; indexdef: string }[]>`
        select indexname, indexdef from pg_indexes where schemaname = 'public'
          and indexname in ('operations_pending_unsent_idx', 'voucher_ownership_voucher_member_idx')`;
        expect(indexes).toHaveLength(2);
        expect(indexes.find((row) => row.indexname === 'voucher_ownership_voucher_member_idx')?.indexdef).toContain(
          'CANCELLED',
        );
        expect(indexes.find((row) => row.indexname === 'operations_pending_unsent_idx')?.indexdef).toContain(
          'sui_tx_digest IS NULL',
        );
      } finally {
        await client?.end();
        // The name is generated here and this connection is the disposable integration database.
        await admin`drop database if exists ${admin(name)}`;
        await admin.end();
        if (folder) await removeFixture(folder);
      }
    },
  );
});
