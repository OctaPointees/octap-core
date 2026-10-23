import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

const POSTGRES_IMAGE = 'postgres:17-alpine';
const REDIS_IMAGE = 'redis:7-alpine';
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../db/postgres/migrations', import.meta.url));
const SUPABASE_COMPAT_SQL = fileURLToPath(
  new URL('../../../../docker/postgres-init/01-supabase-compat.sql', import.meta.url),
);

const containers: StartedTestContainer[] = [];

/**
 * Vitest global setup for the integration project: boots Postgres + Redis once per run and
 * exposes them through `DATABASE_URL`/`REDIS_URL`, which the forked test workers inherit.
 *
 * By default both come from throwaway testcontainers (needs a Docker-compatible engine:
 * Docker, or Podman with `DOCKER_HOST` pointing at its socket). Set `TEST_DATABASE_URL` (and
 * optionally `TEST_REDIS_URL`) to reuse servers that are already running instead — e.g. the
 * `docker-compose.yml` ones. The database name must contain "test": every test truncates it.
 */
export async function setup(): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL ?? (await startPostgres());
  const redisUrl =
    process.env.TEST_REDIS_URL ?? (process.env.TEST_DATABASE_URL ? 'redis://127.0.0.1:6379' : await startRedis());

  await prepareDatabase(databaseUrl);

  process.env.DATABASE_URL = databaseUrl;
  process.env.REDIS_URL = redisUrl;
  process.env.DB_MAX_CONNECTIONS ??= '5';
}

export async function teardown(): Promise<void> {
  await Promise.all(containers.splice(0).map((c) => c.stop()));
}

async function startPostgres(): Promise<string> {
  const container = await new GenericContainer(POSTGRES_IMAGE)
    .withEnvironment({ POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: 'postgres', POSTGRES_DB: 'octap_test' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  containers.push(container);
  return `postgresql://postgres:postgres@${container.getHost()}:${container.getMappedPort(5432)}/octap_test`;
}

async function startRedis(): Promise<string> {
  const container = await new GenericContainer(REDIS_IMAGE)
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
  containers.push(container);
  return `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
}

/**
 * Creates the database if needed, then applies exactly what a fresh `docker-compose` Postgres
 * gets: the Supabase-compat roles/`auth.uid()` (docker/postgres-init), then every drizzle
 * migration. Both are idempotent, so a reused database is simply brought up to date.
 */
async function prepareDatabase(databaseUrl: string): Promise<void> {
  const url = new URL(databaseUrl);
  const database = url.pathname.slice(1);
  if (!/test/i.test(database)) {
    throw new Error(
      `Refusing to run integration tests against "${database}": the database name must contain "test" (every test truncates it).`,
    );
  }

  const admin = postgres({ ...connectionOptions(url), database: 'postgres', max: 1, onnotice: () => {} });
  try {
    const [existing] = await admin`select 1 from pg_database where datname = ${database}`;
    if (!existing) {
      await admin.unsafe(`create database "${database}"`);
    }
  } finally {
    await admin.end();
  }

  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const compat = readFileSync(SUPABASE_COMPAT_SQL, 'utf8');
    await client.unsafe(compat);
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
    // Default privileges only cover tables created after they were set; grant again so a database
    // migrated before the compat script ran still lets the `authenticated` role (withRls) through.
    await client.unsafe(`
      grant select, insert, update, delete on all tables in schema public to authenticated;
      grant all privileges on all tables in schema public to service_role;
    `);
  } finally {
    await client.end();
  }
}

function connectionOptions(url: URL) {
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}
