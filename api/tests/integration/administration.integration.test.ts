import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp } from './support/app.js';
import { resetDb, schema, seedOrganization, seedMember, seedCredential } from './support/db.js';

describe('platform organization governance', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let orgId: string;
  let ids: Record<string, string>;
  const auth = (actor = 'admin') => `Bearer ${actor}`;
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
    ids = {};
    orgId = (await seedOrganization(ctx.db)).id;
    for (const actor of ['owner', 'developer', 'admin', 'outsider']) {
      ids[actor] = (await ctx.http().post('/v1/console/auth/google').send({ idToken: actor })).body.user.id;
      if (actor === 'owner' || actor === 'developer')
        await ctx.db.insert(schema.organizationMemberships).values({
          organizationId: orgId,
          systemUserId: ids[actor],
          role: actor === 'owner' ? 'OWNER' : 'BUSINESS_DEVELOPER',
        });
    }
    await ctx.db
      .update(schema.systemUsers)
      .set({ systemRole: 'SYSTEM_ADMIN' })
      .where(eq(schema.systemUsers.id, ids.admin));
  });
  const propose = (requestType: string, payload: object = {}, platform = false, actor = platform ? 'admin' : 'owner') =>
    ctx
      .http()
      .post(`/v1/${platform ? 'platform' : 'console'}/organizations/${orgId}/change-requests`)
      .set('Authorization', auth(actor))
      .send({ requestType, payload, reason: 'Business requested change' });
  const decide = (id: string, decision = 'approve', actor = 'admin') =>
    ctx
      .http()
      .post(`/v1/platform/change-requests/${id}/${decision}`)
      .set('Authorization', auth(actor))
      .send({ reason: 'Reviewed identity and request' });
  it('atomically transfers ownership and rejects replay and stale transfer requests', async () => {
    const request = await propose('TRANSFER_OWNERSHIP', { targetUserId: ids.developer }).expect(201);
    const stale = await propose('TRANSFER_OWNERSHIP', { targetUserId: ids.developer }).expect(201);
    await decide(request.body.id, 'approve', 'owner').expect(403);
    const results = await Promise.all([decide(request.body.id), decide(request.body.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const rows = await ctx.db.select().from(schema.organizationMemberships);
    expect(rows.find((r) => r.systemUserId === ids.owner)?.role).toBe('BUSINESS_DEVELOPER');
    expect(rows.find((r) => r.systemUserId === ids.developer)?.role).toBe('OWNER');
    await decide(stale.body.id).expect(409);
    await decide(request.body.id, 'reject').expect(409);
    const record = await ctx.db.query.organizationChangeRequests.findFirst({
      where: eq(schema.organizationChangeRequests.id, request.body.id),
    });
    expect(record).toMatchObject({
      status: 'APPROVED',
      reviewedById: ids.admin,
      reason: 'Reviewed identity and request',
    });
    expect(record?.reviewedAt).not.toBeNull();
  });
  it('suspends and reinstates portal/API access without resurrecting revoked credentials', async () => {
    const { memberId } = await seedMember(ctx.db, orgId);
    const { rawKey } = await seedCredential(ctx.db, orgId);
    const revoked = await seedCredential(ctx.db, orgId, { status: 'REVOKED' });
    const balance = () =>
      ctx.http().get(`/v1/credits/members/${memberId}/balance`).set('Authorization', `Bearer ${rawKey}`);
    await balance().expect(200);
    const suspend = await propose('SUSPEND').expect(201);
    await decide(suspend.body.id).expect(201);
    await balance().expect(403);
    await ctx.http().get(`/v1/console/organizations/${orgId}`).set('Authorization', auth('owner')).expect(403);
    expect((await ctx.http().get('/v1/console/me').set('Authorization', auth('owner'))).body.organizations).toEqual([]);
    await propose('REINSTATE', {}, false).expect(403);
    const restore = await propose('REINSTATE', {}, true).expect(201);
    await decide(restore.body.id).expect(201);
    await balance().expect(200);
    await ctx
      .http()
      .get(`/v1/credits/members/${memberId}/balance`)
      .set('Authorization', `Bearer ${revoked.rawKey}`)
      .expect(401);
    const archive = await propose('DEACTIVATE', {}, true).expect(201);
    await decide(archive.body.id).expect(201);
    await balance().expect(403);
    await propose('REINSTATE', {}, true).expect(409);
  });
  it('applies profile approval, rejects without effects, and lists with filters and pagination', async () => {
    const request = await propose('UPDATE_PROFILE', { name: 'Reviewed Name' }, true).expect(201);
    await decide(request.body.id, 'reject').expect(201);
    await decide(request.body.id).expect(409);
    expect((await ctx.db.query.organizations.findFirst({ where: eq(schema.organizations.id, orgId) }))?.name).not.toBe(
      'Reviewed Name',
    );
    const stale = await propose('UPDATE_PROFILE', { name: 'Old Proposal' }, true).expect(201);
    const second = await propose('UPDATE_PROFILE', { name: 'Approved Name' }, true).expect(201);
    await decide(second.body.id).expect(201);
    await decide(stale.body.id).expect(409);
    expect((await ctx.db.query.organizations.findFirst({ where: eq(schema.organizations.id, orgId) }))?.name).toBe(
      'Approved Name',
    );
    const list = await ctx.http().get('/v1/platform/change-requests?limit=1').set('Authorization', auth()).expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.nextCursor).toBeTruthy();
    await ctx
      .http()
      .get(`/v1/platform/change-requests?cursor=${list.body.nextCursor}`)
      .set('Authorization', auth())
      .expect(200);
    const approved = await ctx
      .http()
      .get(`/v1/platform/change-requests?status=APPROVED&organizationId=${orgId}`)
      .set('Authorization', auth())
      .expect(200);
    expect(approved.body.items).toHaveLength(1);
    expect(approved.body.items[0]).toMatchObject({
      requesterEmail: 'admin@example.com',
      reviewerEmail: 'admin@example.com',
    });
  });
  it('validates proposals/decisions and rejects unauthorized actors and ineligible ownership targets', async () => {
    await propose('SUSPEND', {}, false, 'developer').expect(403);
    await propose('SUSPEND', {}, false, 'outsider').expect(403);
    await propose('SUSPEND', {}, true, 'owner').expect(403);
    await propose('TRANSFER_OWNERSHIP', { targetUserId: ids.outsider }).expect(409);
    await propose('TRANSFER_OWNERSHIP', { targetUserId: 'bad' }).expect(400);
    await propose('UPDATE_PROFILE', { name: 'x' }).expect(400);
    await propose('UPDATE_PROFILE', { name: 'Valid Name' }).expect(400);
    await propose('SUSPEND', { status: 'ACTIVE' }).expect(400);
    await propose('UNKNOWN').expect(400);
    await ctx.http().get('/v1/platform/change-requests').set('Authorization', auth('owner')).expect(403);
    for (const query of ['status=BAD', 'cursor=bad', 'limit=0'])
      await ctx.http().get(`/v1/platform/change-requests?${query}`).set('Authorization', auth()).expect(400);
    await decide('00000000-0000-4000-8000-000000000000').expect(404);
    const proposal = await propose('SUSPEND').expect(201);
    await ctx
      .http()
      .post(`/v1/platform/change-requests/${proposal.body.id}/approve`)
      .set('Authorization', auth())
      .send({})
      .expect(400);
  });
  it('routes organization creation approvals through the existing atomic onboarding workflow', async () => {
    const request = await ctx
      .http()
      .post('/v1/console/organization-requests')
      .set('Authorization', auth('owner'))
      .send({
        name: 'New Tenant',
        slug: 'new-tenant',
        organizationType: 'INDIVIDUAL_HOUSEHOLD',
        representativeName: 'Owner Name',
      })
      .expect(201);
    await decide(request.body.id).expect(201);
    await decide(request.body.id).expect(409);
    const list = await ctx
      .http()
      .get('/v1/platform/change-requests?status=APPROVED')
      .set('Authorization', auth())
      .expect(200);
    expect(list.body.items[0].reviewedById).toBe(ids.admin);
  });
});
