import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { asc, eq, getTableColumns } from 'drizzle-orm';
import * as schema from '#infra/db/schema/index.js';
import type { DrizzleDb } from '#infra/db/postgres.provider.js';
import { generateApiKey } from '#infra/auth/api-key-hash.util.js';
import { drainRequestLogWrites } from '#domain/developer/request-log.middleware.js';

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

/**
 * Empties every application table (drizzle's own migration journal lives in another schema). Waits
 * for request-log writes still in flight first: one landing during the truncate deadlocks with it,
 * since its foreign keys lock the organization and key rows the truncate is also locking (PR #84).
 * `audit_log` refuses TRUNCATE by trigger (OCT-333): tests are the one place it is emptied, so the
 * trigger is switched off for this transaction only.
 */
export async function resetDb(target: postgres.Sql | DrizzleDb): Promise<void> {
  await drainRequestLogWrites();
  const client: postgres.Sql = '$client' in target ? (target.$client as postgres.Sql) : (target as postgres.Sql);
  const tables = await client<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public'`;
  if (tables.length > 0) {
    const hasAuditLog = tables.some((t) => t.tablename === 'audit_log');
    await client.begin(async (tx) => {
      if (hasAuditLog) await tx.unsafe('alter table "public"."audit_log" disable trigger "audit_log_no_truncate"');
      await tx.unsafe(
        `truncate table ${tables.map((t) => `"public"."${t.tablename}"`).join(', ')} restart identity cascade`,
      );
      if (hasAuditLog) await tx.unsafe('alter table "public"."audit_log" enable trigger "audit_log_no_truncate"');
    });
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
    scopes = ['read', 'write'],
    expiresAt,
    status,
    environment = 'LIVE',
  }: { scopes?: string[]; expiresAt?: Date; status?: 'ACTIVE' | 'REVOKED'; environment?: 'LIVE' | 'SANDBOX' } = {},
) {
  const { raw, prefix, hash } = generateApiKey(environment);
  const [credential] = await db
    .insert(schema.apiCredentials)
    .values({
      organizationId,
      name: 'test',
      keyPrefix: prefix,
      keyHash: hash,
      scopes,
      expiresAt,
      environment,
      ...(status ? { status } : {}),
    })
    .returning();
  return { credential, rawKey: raw };
}

/** Every webhook delivery with its event's `eventType` and `payload`, oldest first. */
export function deliveriesWithEvents(db: DrizzleDb) {
  return db
    .select({
      ...getTableColumns(schema.webhookDeliveries),
      eventType: schema.organizationEvents.type,
      payload: schema.organizationEvents.payload,
    })
    .from(schema.webhookDeliveries)
    .innerJoin(schema.organizationEvents, eq(schema.organizationEvents.id, schema.webhookDeliveries.eventId))
    .orderBy(asc(schema.organizationEvents.sequence));
}

/** Every organization event's type, in the order recorded. */
export async function eventTypes(db: DrizzleDb, organizationId?: string): Promise<string[]> {
  const rows = await db
    .select({ type: schema.organizationEvents.type })
    .from(schema.organizationEvents)
    .where(organizationId ? eq(schema.organizationEvents.organizationId, organizationId) : undefined)
    .orderBy(asc(schema.organizationEvents.sequence));
  return rows.map((row) => row.type);
}

/** Every organization event of `type`, in the order recorded. */
export function eventsOfType(db: DrizzleDb, type: string) {
  return db
    .select()
    .from(schema.organizationEvents)
    .where(eq(schema.organizationEvents.type, type))
    .orderBy(asc(schema.organizationEvents.sequence));
}

/** Queues a delivery of a made-up event to `endpointId`, as `recordEvent` would. */
export async function seedDelivery(
  db: DrizzleDb,
  params: Omit<typeof schema.webhookDeliveries.$inferInsert, 'eventId'> & { type?: string; payload?: unknown },
) {
  const { type = 'test', payload = {}, ...delivery } = params;
  const [event] = await db
    .insert(schema.organizationEvents)
    .values({ organizationId: delivery.organizationId, type, payload })
    .returning();
  const [created] = await db
    .insert(schema.webhookDeliveries)
    .values({ ...delivery, eventId: event.id })
    .returning();
  return created;
}

/** The four plans migration 0038 seeds (`resetDb` empties them), by tier. */
export async function seedLicensePlans(db: DrizzleDb) {
  const all = ['voucher.batches', 'voucher.approval', 'webhooks', 'mcp', 'assistant', 'sandbox'] as const;
  const rows = await db
    .insert(schema.licensePlans)
    .values([
      {
        tier: 'TRIAL',
        name: 'Trial',
        monthlyPriceVnd: 0,
        termMonthsAllowed: [],
        durationDays: 14,
        purchasable: false,
        entitlements: {
          features: [...all],
          limits: { transactionsMonthly: 1000, members: 500, apiKeys: 2, teamMembers: 3 },
        },
      },
      {
        tier: 'STARTER',
        name: 'Starter',
        monthlyPriceVnd: 990_000,
        termMonthsAllowed: [3, 6, 12],
        entitlements: {
          features: ['voucher.batches', 'webhooks', 'sandbox'],
          limits: { transactionsMonthly: 10_000, members: 5000, apiKeys: 2, teamMembers: 3 },
        },
      },
      {
        tier: 'GROWTH',
        name: 'Growth',
        monthlyPriceVnd: 2_990_000,
        termMonthsAllowed: [3, 6, 12],
        entitlements: {
          features: [...all],
          limits: { transactionsMonthly: 50_000, members: 50_000, apiKeys: 10, teamMembers: 10 },
        },
      },
      {
        tier: 'ENTERPRISE',
        name: 'Enterprise',
        monthlyPriceVnd: 0,
        termMonthsAllowed: [],
        purchasable: false,
        entitlements: {
          features: [...all],
          limits: { transactionsMonthly: null, members: null, apiKeys: 25, teamMembers: null },
        },
      },
    ])
    .returning();
  return Object.fromEntries(rows.map((plan) => [plan.tier, plan])) as Record<
    (typeof rows)[number]['tier'],
    (typeof rows)[number]
  >;
}

/** A license for `organizationId` from `plan`, copying its entitlements as granting one does. */
export async function seedLicense(
  db: DrizzleDb,
  organizationId: string,
  plan: typeof schema.licensePlans.$inferSelect,
  { startsAt = new Date(), endsAt = new Date(Date.now() + 30 * 86_400_000), source = 'ADMIN' as const } = {},
) {
  const [license] = await db
    .insert(schema.licenses)
    .values({
      organizationId,
      planId: plan.id,
      tier: plan.tier,
      planName: plan.name,
      entitlements: plan.entitlements,
      source,
      startsAt,
      endsAt,
    })
    .returning();
  return license;
}
