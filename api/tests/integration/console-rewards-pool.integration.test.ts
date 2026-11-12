import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './support/app.js';
import { resetDb, schema, seedOrganization, seedProgram } from './support/db.js';

/**
 * With one pooled connection, a request that queried on a second connection while its transaction
 * held the first would wait forever. Every console reward route must finish on one.
 */
describe('console rewards on a one-connection pool', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  const previous = process.env.DB_MAX_CONNECTIONS;
  const google = {
    verify: async (token: string) => ({
      subject: token,
      email: `${token}@example.com`,
      fullName: token,
      avatarUrl: null,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    }),
  };

  beforeAll(async () => {
    process.env.DB_MAX_CONNECTIONS = '1';
    ctx = await createTestApp(undefined, google);
  });
  afterAll(async () => {
    await ctx?.close();
    if (previous === undefined) delete process.env.DB_MAX_CONNECTIONS;
    else process.env.DB_MAX_CONNECTIONS = previous;
  });

  it('creates, activates, lists and reads a voucher without a second connection', { timeout: 15_000 }, async () => {
    await resetDb(ctx.db);
    const owner = (await ctx.http().post('/v1/console/auth/google').send({ idToken: 'owner' }).expect(201)).body.user
      .id as string;
    const orgId = (await seedOrganization(ctx.db)).id;
    await seedProgram(ctx.db, orgId);
    await ctx.db
      .insert(schema.organizationMemberships)
      .values({ organizationId: orgId, systemUserId: owner, role: 'OWNER' });
    const path = `/v1/console/organizations/${orgId}/vouchers`;
    const as = { Authorization: 'Bearer owner' };

    const body = { code: 'pool', title: 'Pool', discountType: 'FREE_ITEM', pointsCost: 10 };
    const created = (await ctx.http().post(path).set(as).send(body).expect(201)).body as { id: string };
    // Activating looks the program up inside the Owner check's transaction.
    await ctx.http().patch(`${path}/${created.id}`).set(as).send({ status: 'ACTIVE' }).expect(200);
    expect((await ctx.http().get(path).set(as).expect(200)).body).toHaveLength(1);
    await ctx.http().get(`${path}/${created.id}`).set(as).expect(200);
  });
});
