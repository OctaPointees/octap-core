import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp } from './support/app.js';
import { resetDb, schema, seedOrganization, seedMember, setOwnership } from './support/db.js';
import { CreditsRepository } from '#infra/db/repositories/credits.repository.js';

describe('tenant customer member directory', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let orgId: string;
  let memberId: string;
  let otherId: string;
  const bearer = (actor = 'owner') => `Bearer ${actor}`;
  beforeAll(async () => {
    ctx = await createTestApp(undefined, {
      verify: async (subject: string) => ({
        subject,
        email: `${subject}@example.com`,
        fullName: subject,
        avatarUrl: null,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
    });
  });
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await resetDb(ctx.db);
    orgId = (await seedOrganization(ctx.db)).id;
    otherId = (await seedOrganization(ctx.db)).id;
    for (const actor of ['owner', 'developer', 'outsider']) {
      const login = await ctx.http().post('/v1/console/auth/google').send({ idToken: actor }).expect(201);
      if (actor !== 'outsider')
        await ctx.db.insert(schema.organizationMemberships).values({
          organizationId: orgId,
          systemUserId: login.body.user.id,
          role: actor === 'owner' ? 'OWNER' : 'BUSINESS_DEVELOPER',
        });
    }
    const { member } = await seedMember(ctx.db, orgId);
    memberId = member.id;
    await ctx.db
      .update(schema.endUsers)
      .set({ displayName: 'Alice Customer', email: 'alice@example.com' })
      .where(eq(schema.endUsers.id, member.endUserId));
    await ctx.db
      .update(schema.organizationEndUsers)
      .set({ externalMemberId: 'POS-1' })
      .where(eq(schema.organizationEndUsers.id, memberId));
    await setOwnership(ctx.db, memberId, { confirmedBalance: 123, pendingEarn: 5 });
    await seedMember(ctx.db, otherId);
  });
  const path = () => `/v1/console/organizations/${orgId}/members`;
  it('lists, searches, paginates and returns current balance without tenant leaks', async () => {
    await seedMember(ctx.db, orgId);
    const first = await ctx.http().get(`${path()}?limit=1`).set('Authorization', bearer('developer')).expect(200);
    expect(first.body.items).toHaveLength(1);
    const second = await ctx
      .http()
      .get(`${path()}?limit=1&cursor=${first.body.nextCursor}`)
      .set('Authorization', bearer())
      .expect(200);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
    expect(second.body.nextCursor).toBeNull();
    for (const query of ['q=alice', 'externalMemberId=POS-1', 'tier=BRONZE&status=ACTIVE']) {
      const result = await ctx.http().get(`${path()}?${query}`).set('Authorization', bearer()).expect(200);
      expect(result.body.items.some((item: { id: string }) => item.id === memberId)).toBe(true);
    }
    const detail = await ctx.http().get(`${path()}/${memberId}`).set('Authorization', bearer()).expect(200);
    expect(detail.body.balance).toMatchObject({ confirmedBalance: 123, pendingEarn: 5, stale: true });
    await ctx.http().get(path()).set('Authorization', bearer('outsider')).expect(403);
    await ctx.http().get(`/v1/console/organizations/${otherId}/members`).set('Authorization', bearer()).expect(403);
    await ctx.http().get(`${path()}/00000000-0000-4000-8000-000000000000`).set('Authorization', bearer()).expect(404);
    await ctx
      .http()
      .patch(`${path()}/00000000-0000-4000-8000-000000000000`)
      .set('Authorization', bearer())
      .send({ tier: 'GOLD' })
      .expect(404);
  });
  it('permits only Owners to edit scoped membership and enforces external ID uniqueness', async () => {
    const patch = (body: object, actor = 'owner', id = memberId) =>
      ctx.http().patch(`${path()}/${id}`).set('Authorization', bearer(actor)).send(body);
    await patch({ tier: 'GOLD' }, 'developer').expect(403);
    await patch({ tier: 'GOLD', status: 'BLOCKED', externalMemberId: 'POS-2', metadata: { source: 'POS' } }).expect(
      200,
    );
    const row = await ctx.http().get(`${path()}/${memberId}`).set('Authorization', bearer()).expect(200);
    expect(row.body).toMatchObject({
      tier: 'GOLD',
      status: 'BLOCKED',
      externalMemberId: 'POS-2',
      metadata: { source: 'POS' },
    });
    const { member: another } = await seedMember(ctx.db, orgId);
    await patch({ externalMemberId: 'POS-2' }, 'owner', another.id).expect(409);
    for (const body of [
      {},
      { role: 'OWNER' },
      { tier: 'bad tier' },
      { status: 'DELETED' },
      { metadata: [] },
      { externalMemberId: '' },
    ])
      await patch(body).expect(400);
    for (const query of ['limit=0', 'cursor=bad', 'status=DELETED', `q=${'a'.repeat(161)}`])
      await ctx.http().get(`${path()}?${query}`).set('Authorization', bearer()).expect(400);
    await patch({ externalMemberId: null, status: 'ACTIVE' }).expect(200);
  });
  it('blocks new earn/redemption acceptance for blocked members before creating operations', async () => {
    await ctx
      .http()
      .patch(`${path()}/${memberId}`)
      .set('Authorization', bearer())
      .send({ status: 'BLOCKED' })
      .expect(200);
    const credits = new CreditsRepository(ctx.db);
    const params = {
      organizationId: orgId,
      organizationEndUserId: memberId,
      pointsAmount: 10,
      idempotencyKey: 'blocked',
    };
    await expect(credits.recordEarnTransaction(params)).rejects.toMatchObject({ status: 403 });
    await expect(credits.reservePosRedemption(params)).rejects.toMatchObject({ status: 403 });
    expect(await ctx.db.select().from(schema.operations)).toEqual([]);
    await ctx.db
      .update(schema.organizationEndUsers)
      .set({ status: 'ACTIVE' })
      .where(eq(schema.organizationEndUsers.id, memberId));
    const [member] = await ctx.db
      .select()
      .from(schema.organizationEndUsers)
      .where(eq(schema.organizationEndUsers.id, memberId));
    await ctx.db.update(schema.endUsers).set({ status: 'BLOCKED' }).where(eq(schema.endUsers.id, member.endUserId));
    await expect(credits.recordEarnTransaction(params)).rejects.toMatchObject({ status: 403 });
    await ctx.db.update(schema.organizations).set({ status: 'SUSPENDED' }).where(eq(schema.organizations.id, orgId));
    await expect(credits.recordEarnTransaction(params)).rejects.toMatchObject({ status: 403 });
  });
});
