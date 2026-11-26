// Applies the database migrations to DATABASE_URL (OCT-316). The deploy runs it once, as its own
// task, before the new API and workers start; a failure stops the deploy.
//
// The migrations assume Supabase's roles (anon, authenticated, service_role) and auth.uid(). On a
// database that lacks them, such as RDS, this creates them first with the same compat script the
// local containers use, and lets the connecting user switch to `authenticated` (withRls() does).
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const [{ supabase }] = await sql`select exists (select 1 from pg_roles where rolname = 'authenticated') as supabase`;
  if (!supabase) {
    console.log('No Supabase roles: creating them');
    await sql.unsafe(
      await readFile(new URL('../docker/postgres-init/01-supabase-compat.sql', import.meta.url), 'utf8'),
    );
  }
  const [{ member }] = await sql`select pg_has_role(current_user, 'authenticated', 'SET') as member`;
  if (!member) await sql.unsafe('grant authenticated to current_user with set true');

  await migrate(drizzle(sql), {
    migrationsFolder: fileURLToPath(new URL('../api/db/postgres/migrations', import.meta.url)),
  });
  // Default privileges only cover tables created after they were set; grant again so the
  // `authenticated` role (withRls) reaches every table.
  await sql.unsafe(`
    grant select, insert, update, delete on all tables in schema public to authenticated;
    grant all privileges on all tables in schema public to service_role;
    -- The audit log is append-only (OCT-333): the tenant role reads and inserts, nothing else.
    revoke update, delete, truncate on audit_log from authenticated;
  `);
  console.log('Migrations applied');
} finally {
  await sql.end();
}
