import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '#infra/db/schema/index.js';
import type { DrizzleDb } from '#infra/db/postgres.provider.js';
import { generateApiKey } from '#infra/auth/api-key-hash.util.js';

export { schema };

/** One drizzle handle per test file, on the database the global setup prepared. */
export function connectTestDb(): { db: DrizzleDb; client: postgres.Sql } {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set: run integration tests through `npm run test:integration`.');
  }
  const client = postgres(databaseUrl, { max: 5, onnotice: () => {} });
  return { db: drizzle(client, { schema }), client };
}

/** Empties every application table (drizzle's own migration journal lives in another schema). */
export async function resetDb(target: postgres.Sql | DrizzleDb): Promise<void> {
  const client: postgres.Sql = '$client' in target ? (target.$client as postgres.Sql) : (target as postgres.Sql);
  const tables = await client<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public'`;
  if (tables.length > 0) {
    await client.unsafe(
      `truncate table ${tables.map((t) => `"public"."${t.tablename}"`).join(', ')} restart identity cascade`,
    );
  }
}

export async function seedOrganization(
  db: DrizzleDb,
  overrides: Partial<typeof schema.organizations.$inferInsert> = {},
) {
  const suffix = randomUUID().slice(0, 8);
  const [org] = await db
    .insert(schema.organizations)
    .values({ slug: `org-${suffix}`, name: `Org ${suffix}`, ...overrides })
    .returning();
  return org;
}

/** An `ACTIVE`, sharded program for `organizationId`, as `scripts/provision-program.mjs` leaves it. */
export async function seedProgram(
  db: DrizzleDb,
  organizationId: string,
  overrides: Partial<typeof schema.programs.$inferInsert> = {},
) {
  const [program] = await db
    .insert(schema.programs)
    .values({
      organizationId,
      status: 'ACTIVE',
      programControlId: `0xprogram-${organizationId}`,
      adminCapId: `0xadmincap-${organizationId}`,
      policyVersionId: `0xpolicy-${organizationId}`,
      issuerCapId: `0xissuercap-${organizationId}`,
      policyVersion: 1,
      earnBps: 100,
      expiryMs: 30 * 24 * 60 * 60 * 1000,
      shardCount: 1,
      totalBudget: 1_000_000,
      operationShardIds: [`0xop0-${organizationId}`],
      budgetShardIds: [`0xbudget0-${organizationId}`],
      ...overrides,
    })
    .returning();
  return program;
}

/** An end user (with a zkLogin address) enrolled in `organizationId`, as IdentityService would leave it. */
export async function seedMember(
  db: DrizzleDb,
  organizationId: string,
  {
    suiAddress = `0x${randomUUID().replaceAll('-', '')}`,
    withAddress = true,
  }: { suiAddress?: string; withAddress?: boolean } = {},
) {
  const [endUser] = await db
    .insert(schema.endUsers)
    .values({ suiAddress: withAddress ? suiAddress : null })
    .returning();
  const [member] = await db
    .insert(schema.organizationEndUsers)
    .values({ organizationId, endUserId: endUser.id })
    .returning();
  return { endUser, member, memberId: member.id };
}

/** Puts a member's ownership row into an exact state (creating it if needed). */
export async function setOwnership(
  db: DrizzleDb,
  organizationEndUserId: string,
  values: Partial<typeof schema.creditOwnerships.$inferInsert>,
) {
  const [existing] = await db
    .select()
    .from(schema.creditOwnerships)
    .where(eq(schema.creditOwnerships.organizationEndUserId, organizationEndUserId));
  if (existing) {
    const [updated] = await db
      .update(schema.creditOwnerships)
      .set(values)
      .where(eq(schema.creditOwnerships.id, existing.id))
      .returning();
    return updated;
  }
  const [created] = await db
    .insert(schema.creditOwnerships)
    .values({ organizationEndUserId, ...values })
    .returning();
  return created;
}

export async function getOwnership(db: DrizzleDb, organizationEndUserId: string) {
  const [row] = await db
    .select()
    .from(schema.creditOwnerships)
    .where(eq(schema.creditOwnerships.organizationEndUserId, organizationEndUserId));
  return row;
}

export async function insertLoyaltyTransaction(db: DrizzleDb, values: typeof schema.loyaltyTransactions.$inferInsert) {
  const [row] = await db.insert(schema.loyaltyTransactions).values(values).returning();
  return row;
}

export async function getLoyaltyTransaction(db: DrizzleDb, id: string) {
  const [row] = await db.select().from(schema.loyaltyTransactions).where(eq(schema.loyaltyTransactions.id, id));
  return row;
}

/** Issues an API credential row directly; returns the raw key the guard will hash and look up. */
export async function seedCredential(
  db: DrizzleDb,
  organizationId: string,
  {
    scopes = ['read', 'write', 'admin'],
    expiresAt,
    status,
  }: { scopes?: string[]; expiresAt?: Date; status?: 'ACTIVE' | 'REVOKED' } = {},
) {
  const { raw, prefix, hash } = generateApiKey();
  const [credential] = await db
    .insert(schema.apiCredentials)
    .values({
      organizationId,
      name: 'test',
      keyPrefix: prefix,
      keyHash: hash,
      scopes,
      expiresAt,
      ...(status ? { status } : {}),
    })
    .returning();
  return { credential, rawKey: raw };
}
