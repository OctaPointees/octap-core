import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { createTestApp } from './support/app.js';
import { resetDb, schema, seedOrganization, seedCredential } from './support/db.js';
import { withRls } from '#infra/db/rls.js';

describe('console onboarding and protected portal operations', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: Record<string, string>;
  const google = {
    verify: async (token: string) => {
      if (!['owner', 'developer', 'stranger', 'admin'].includes(token)) throw new UnauthorizedException();
      return {
        subject: token,
        email: `${token}@example.com`,
        fullName: token,
        avatarUrl: null,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
    },
  };
  beforeAll(async () => {
    ctx = await createTestApp(undefined, google);
  });
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    vi.stubEnv('ORGANIZATION_IDENTITY_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
    await resetDb(ctx.db);
    ids = {};
    for (const actor of ['owner', 'developer', 'stranger', 'admin']) {
      ids[actor] = (await ctx.http().post('/v1/console/auth/google').send({ idToken: actor }).expect(201)).body.user.id;
    }
    await ctx.db
      .update(schema.systemUsers)
      .set({ systemRole: 'SYSTEM_ADMIN' })
      .where(eq(schema.systemUsers.id, ids.admin));
  });
  const bearer = (actor: string) => `Bearer ${actor}`;
  const apply = (slug = 'new-business') =>
    ctx.http().post('/v1/console/organization-requests').set('Authorization', bearer('owner')).send({
      name: 'New Business',
      slug,
      organizationType: 'INDIVIDUAL_HOUSEHOLD',
      representativeName: 'Business Owner',
      systemRole: 'SYSTEM_ADMIN',
      role: 'OWNER',
      status: 'ACTIVE',
    });
  async function approved() {
    const request = await apply().expect(201);
    const approval = await ctx
      .http()
      .post(`/v1/platform/organization-requests/${request.body.id}/approve`).send({ reason: 'Reviewed application' })
      .set('Authorization', bearer('admin'))
      .send({})
      .expect(201);
    return { id: approval.body.organizationId as string, requestId: request.body.id as string };
  }
  const invite = (id: string, email = 'developer@example.com') =>
    ctx
      .http()
      .post(`/v1/console/organizations/${id}/invitations`)
      .set('Authorization', bearer('owner'))
      .send({ email });
  const accept = (token: string, actor = 'developer') =>
    ctx.http().post(`/v1/console/invitations/${token}/accept`).set('Authorization', bearer(actor)).send({});

  it('lets only Owners suspend and restore Developers without changing ownership', async () => {
    const org = await approved();
    await accept((await invite(org.id).expect(201)).body.token).expect(201);
    const access = (actor: string, target: string, body: object) =>
      ctx
        .http()
        .patch(`/v1/console/organizations/${org.id}/staff/${target}`)
        .set('Authorization', bearer(actor))
        .send(body);
    for (const actor of ['developer', 'stranger', 'admin'])
      await access(actor, ids.developer, { status: 'SUSPENDED' }).expect(403);
    await access('owner', ids.owner, { status: 'SUSPENDED' }).expect(403);
    await access('owner', ids.developer, { status: 'ACTIVE', role: 'OWNER' }).expect(400);
    await access('owner', ids.developer, { status: 'DELETED' }).expect(400);
    await access('owner', ids.stranger, { status: 'ACTIVE' }).expect(404);
    const pending = await invite(org.id).expect(201);
    await access('owner', ids.developer, { status: 'SUSPENDED' }).expect(200);
    await accept(pending.body.token).expect(410);
    await ctx
      .http()
      .get(`/v1/console/organizations/${org.id}/api-credentials`)
      .set('Authorization', bearer('developer'))
      .expect(403);
    expect(
      (await ctx.http().get('/v1/console/me').set('Authorization', bearer('developer'))).body.organizations,
    ).toEqual([]);
    await access('owner', ids.developer, { status: 'ACTIVE' }).expect(200);
    await ctx
      .http()
      .get(`/v1/console/organizations/${org.id}/api-credentials`)
      .set('Authorization', bearer('developer'))
      .expect(200);
  });
  it('blocks older invitations after suspension even when the stored email changed', async () => {
    const org = await approved();
    await accept((await invite(org.id).expect(201)).body.token).expect(201);
    const pending = await invite(org.id).expect(201);
    await ctx.db
      .update(schema.systemUsers)
      .set({ email: 'old-profile@example.com' })
      .where(eq(schema.systemUsers.id, ids.developer));
    await ctx
      .http()
      .patch(`/v1/console/organizations/${org.id}/staff/${ids.developer}`)
      .set('Authorization', bearer('owner'))
      .send({ status: 'SUSPENDED' })
      .expect(200);
    await accept(pending.body.token).expect(410);
    const [row] = await ctx.db
      .select()
      .from(schema.organizationMemberships)
      .where(eq(schema.organizationMemberships.systemUserId, ids.developer));
    expect(row.status).toBe('SUSPENDED');
    await ctx
      .http()
      .post(`/v1/console/organizations/${org.id}/invitations/${pending.body.id}/revoke`)
      .set('Authorization', bearer('owner'))
      .send({})
      .expect(201);
    const fresh = await invite(org.id).expect(201);
    await accept(fresh.body.token).expect(201); // A new Owner-issued invitation explicitly restores access.
  });
  it('bootstraps only the first Google-bound Owner of an active organization', async () => {
    const org = await seedOrganization(ctx.db);
    const bootstrap = (actor: string, id = org.id, target = ids.owner) =>
      ctx
        .http()
        .post(`/v1/platform/organizations/${id}/owner`)
        .set('Authorization', bearer(actor))
        .send({ systemUserId: target });
    await bootstrap('owner').expect(403);
    await bootstrap('admin', org.id, 'invalid').expect(400);
    const [legacy] = await ctx.db
      .insert(schema.systemUsers)
      .values({ email: 'legacy@example.com', fullName: 'Legacy' })
      .returning();
    await bootstrap('admin', org.id, legacy.id).expect(400);
    const pending = await seedOrganization(ctx.db, { status: 'PENDING_APPROVAL' });
    await bootstrap('admin', pending.id).expect(409);
    await bootstrap('admin', '00000000-0000-4000-8000-000000000000').expect(404);
    await ctx.db
      .insert(schema.organizationMemberships)
      .values({ organizationId: org.id, systemUserId: ids.owner, role: 'BUSINESS_DEVELOPER' });
    const results = await Promise.all([bootstrap('admin'), bootstrap('admin')]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const audits = await ctx.db
      .select()
      .from(schema.organizationChangeRequests)
      .where(eq(schema.organizationChangeRequests.organizationId, org.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      requestedById: ids.admin,
      reviewedById: ids.admin,
      requestType: 'TRANSFER_OWNERSHIP',
      status: 'APPROVED',
      payload: { bootstrap: true, previousOwnerId: null, targetUserId: ids.owner },
    });
    expect(audits[0].reviewedAt).toBeInstanceOf(Date);
    await ctx.db
      .update(schema.organizationMemberships)
      .set({ status: 'SUSPENDED' })
      .where(eq(schema.organizationMemberships.organizationId, org.id));
    await bootstrap('admin', org.id, ids.developer).expect(409);
  });
  it('requires Google credentials on all console/platform operations', async () => {
    await ctx.http().get('/v1/console/organization-requests').expect(401);
    await ctx.http().get('/v1/platform/organization-requests').set('Authorization', 'Bearer fake').expect(401);
    await ctx.http().get('/v1/platform/organization-requests').set('Authorization', bearer('owner')).expect(403);
    await ctx.http().get('/v1/console/organizations/not-a-uuid').set('Authorization', bearer('owner')).expect(400);
  });
  it('creates no privileges until approval and applies approval atomically with an audit actor', async () => {
    const request = await apply().expect(201);
    const [org] = await ctx.db.select().from(schema.organizations);
    expect(org.status).toBe('PENDING_APPROVAL');
    expect(await ctx.db.select().from(schema.organizationMemberships)).toEqual([]);
    await ctx.http().get(`/v1/console/organizations/${org.id}`).set('Authorization', bearer('owner')).expect(403);
    expect(
      (await ctx.http().get('/v1/console/organization-requests').set('Authorization', bearer('stranger')).expect(200))
        .body,
    ).toEqual([]);
    await ctx
      .http()
      .post(`/v1/platform/organization-requests/${request.body.id}/approve`).send({ reason: 'Reviewed application' })
      .set('Authorization', bearer('owner'))
      .send({})
      .expect(403);
    await ctx
      .http()
      .post(`/v1/platform/organization-requests/${request.body.id}/approve`).send({ reason: 'Reviewed application' })
      .set('Authorization', bearer('admin'))
      .send({})
      .expect(201);
    const [membership] = await ctx.db.select().from(schema.organizationMemberships);
    expect(membership).toMatchObject({
      organizationId: org.id,
      systemUserId: ids.owner,
      role: 'OWNER',
      status: 'ACTIVE',
    });
    const [record] = await ctx.db.select().from(schema.organizationChangeRequests);
    expect(record).toMatchObject({ status: 'APPROVED', reviewedById: ids.admin, requestedById: ids.owner });
    expect(record.reviewedAt).not.toBeNull();
    await ctx
      .http()
      .post(`/v1/platform/organization-requests/${request.body.id}/approve`).send({ reason: 'Reviewed application' })
      .set('Authorization', bearer('admin'))
      .send({})
      .expect(409);
    expect(
      (await ctx.http().get('/v1/console/me').set('Authorization', bearer('owner')).expect(200)).body.organizations[0]
        .persona,
    ).toBe('BUSINESS_OWNER');
    expect(
      (await ctx.http().get('/v1/platform/organization-requests').set('Authorization', bearer('admin')).expect(200))
        .body,
    ).toHaveLength(1);
  });
  it('validates requests, rejects duplicate slugs and retains rejection reasons without a membership', async () => {
    for (const body of [
      {},
      { name: 'a', slug: 'valid-slug' },
      { name: 'Business', slug: 'admin' },
      { name: 'Business', slug: 'BAD' },
      { name: 'Business', slug: 'valid-slug', legalName: 12 },
    ]) {
      await ctx
        .http()
        .post('/v1/console/organization-requests')
        .set('Authorization', bearer('owner'))
        .send(body)
        .expect(400);
    }
    const request = await apply().expect(201);
    await apply().expect(409);
    const path = `/v1/platform/organization-requests/${request.body.id}/reject`;
    await ctx.http().post(path).set('Authorization', bearer('admin')).send({}).expect(400);
    await ctx
      .http()
      .post(path)
      .set('Authorization', bearer('admin'))
      .send({ reason: 'Please provide a valid legal name' })
      .expect(201);
    await ctx.http().post(path).set('Authorization', bearer('admin')).send({ reason: 'Again' }).expect(409);
    expect(
      (await ctx.http().get('/v1/console/organization-requests').set('Authorization', bearer('owner')).expect(200))
        .body[0],
    ).toMatchObject({ status: 'REJECTED', reason: 'Please provide a valid legal name', slug: 'new-business' });
    const platform = await ctx
      .http()
      .get('/v1/platform/organization-requests')
      .set('Authorization', bearer('admin'))
      .expect(200);
    expect(platform.body[0].slug).toBe('new-business');
    expect(platform.body[0]).not.toHaveProperty('payload');
    const saved = await ctx.db.query.organizationChangeRequests.findFirst({
      where: eq(schema.organizationChangeRequests.id, request.body.id),
    });
    expect(saved?.payload).toMatchObject({ requestedSlug: 'new-business', initialOwnerId: ids.owner });
    expect(await ctx.db.select().from(schema.organizationMemberships)).toEqual([]);
    expect((await ctx.db.select().from(schema.organizations))[0].status).toBe('ARCHIVED');
    await apply().expect(201); // Rejection releases the public slug for a corrected application.
  });
  it('backfills pending legacy request slugs before rejection and falls back for historical rows', async () => {
    const request = await apply('legacy-business').expect(201);
    await ctx.db
      .update(schema.organizationChangeRequests)
      .set({ payload: { initialOwnerId: ids.owner } })
      .where(eq(schema.organizationChangeRequests.id, request.body.id));
    const list = () =>
      ctx.http().get('/v1/platform/organization-requests').set('Authorization', bearer('admin')).expect(200);
    expect((await list()).body[0].slug).toBe('legacy-business');
    await ctx
      .http()
      .post(`/v1/platform/organization-requests/${request.body.id}/reject`)
      .set('Authorization', bearer('admin'))
      .send({ reason: 'Please correct the application' })
      .expect(201);
    expect((await list()).body[0].slug).toBe('legacy-business');
    const [org] = await ctx.db.select().from(schema.organizations);
    expect(org.slug).toMatch(/^rejected-/);
    await ctx.db
      .update(schema.organizationChangeRequests)
      .set({ payload: {} })
      .where(eq(schema.organizationChangeRequests.id, request.body.id));
    expect((await list()).body[0].slug).toBe(org.slug); // Already lost historical names cannot be reconstructed.
    await ctx.db
      .update(schema.organizationChangeRequests)
      .set({ payload: { requestedSlug: 123 } })
      .where(eq(schema.organizationChangeRequests.id, request.body.id));
    expect((await list()).body[0].slug).toBe(org.slug);
  });
  it('protects owner/developer operations, tenant boundaries and safe credential metadata', async () => {
    const { id } = await approved();
    const invitation = await invite(id).expect(201);
    await accept(invitation.body.token).expect(201);
    const orgPath = `/v1/console/organizations/${id}`;
    expect((await ctx.http().get(orgPath).set('Authorization', bearer('developer')).expect(200)).body.persona).toBe(
      'BUSINESS_DEVELOPER',
    );
    await ctx.http().get(orgPath).set('Authorization', bearer('stranger')).expect(403);
    await ctx.http().get(orgPath).set('Authorization', bearer('admin')).expect(403); // Platform role grants no tenant membership.
    await ctx
      .http()
      .patch(`${orgPath}/profile`)
      .set('Authorization', bearer('developer'))
      .send({ name: 'Stolen' })
      .expect(403);
    await ctx
      .http()
      .patch(`${orgPath}/profile`)
      .set('Authorization', bearer('owner'))
      .send({ name: 'Updated Business', legalName: 'Legal Co', systemRole: 'SYSTEM_ADMIN', status: 'SUSPENDED' })
      .expect(200);
    expect((await ctx.db.select().from(schema.organizations))[0]).toMatchObject({
      name: 'Updated Business',
      legalName: 'Legal Co',
      status: 'ACTIVE',
    });
    await ctx.http().get(`${orgPath}/staff`).set('Authorization', bearer('developer')).expect(403);
    const staff = await ctx.http().get(`${orgPath}/staff`).set('Authorization', bearer('owner')).expect(200);
    expect(staff.body).toHaveLength(2);
    expect(JSON.stringify(staff.body)).not.toContain('passwordHash');
    await ctx
      .http()
      .post(`${orgPath}/invitations`)
      .set('Authorization', bearer('developer'))
      .send({ email: 'stranger@example.com' })
      .expect(403);
    await seedCredential(ctx.db, id);
    const other = await seedOrganization(ctx.db);
    await seedCredential(ctx.db, other.id);
    const credentials = await ctx
      .http()
      .get(`${orgPath}/api-credentials`)
      .set('Authorization', bearer('developer'))
      .expect(200);
    expect(credentials.body).toHaveLength(1);
    expect(credentials.body[0]).not.toHaveProperty('keyHash');
    await ctx
      .http()
      .get(`/v1/console/organizations/${other.id}/api-credentials`)
      .set('Authorization', bearer('developer'))
      .expect(403);
    await ctx.db
      .update(schema.organizationMemberships)
      .set({ status: 'INACTIVE' })
      .where(eq(schema.organizationMemberships.systemUserId, ids.developer));
    await ctx.http().get(orgPath).set('Authorization', bearer('developer')).expect(403);
  });
  it('binds a one-time invitation to the verified email and stores only its hash', async () => {
    const { id } = await approved();
    const result = await invite(id).expect(201);
    const [stored] = await ctx.db.select().from(schema.invitations);
    expect(stored.token).toMatch(/^sha256:/);
    expect(stored.token).not.toBe(result.body.token);
    await accept(result.body.token, 'stranger').expect(403);
    const listed = await ctx
      .http()
      .get(`/v1/console/organizations/${id}/invitations`)
      .set('Authorization', bearer('owner'))
      .expect(200);
    expect(listed.body[0]).not.toHaveProperty('token');
    await invite(id).expect(409);
    await accept(result.body.token).expect(201);
    await accept(result.body.token).expect(410);
    expect(
      (await ctx.db.select().from(schema.organizationMemberships)).filter((row) => row.systemUserId === ids.developer),
    ).toHaveLength(1);
    // No public Data API reads or writes to invitation secrets / governance requests.
    await withRls(ctx.db, { userId: ids.owner }, async (tx) => {
      expect(await tx.select().from(schema.invitations)).toEqual([]);
      expect(await tx.select().from(schema.organizationChangeRequests)).toEqual([]);
    });
  });
  it('supports revoke and re-invite, expired invitations and rejects role escalation', async () => {
    const { id } = await approved();
    const path = `/v1/console/organizations/${id}/invitations`;
    for (const body of [{ email: 'bad' }, { email: 'developer@example.com', persona: 'BUSINESS_OWNER' }])
      await ctx.http().post(path).set('Authorization', bearer('owner')).send(body).expect(400);
    const first = await invite(id).expect(201);
    await ctx.http().post(`${path}/${first.body.id}/revoke`).set('Authorization', bearer('owner')).send({}).expect(201);
    await accept(first.body.token).expect(410);
    const second = await invite(id).expect(201);
    await ctx.db
      .update(schema.invitations)
      .set({ expiresAt: new Date(1) })
      .where(eq(schema.invitations.id, second.body.id));
    await accept(second.body.token).expect(410);
    expect(
      (await ctx.http().get(path).set('Authorization', bearer('owner')).expect(200)).body.find(
        (row: { id: string }) => row.id === second.body.id,
      ).status,
    ).toBe('EXPIRED');
    await invite(id).expect(201);
    await accept('x'.repeat(64)).expect(404);
    await accept('a'.repeat(64)).expect(404);
  });
  it('serializes concurrent approvals and invitation acceptance without duplicate grants', async () => {
    const request = await apply().expect(201);
    const decisions = await Promise.all(
      Array.from({ length: 2 }, () =>
        ctx
          .http()
          .post(`/v1/platform/organization-requests/${request.body.id}/approve`).send({ reason: 'Reviewed application' })
          .set('Authorization', bearer('admin'))
          .send({}),
      ),
    );
    expect(decisions.map((row) => row.status).sort()).toEqual([201, 409]);
    const id = decisions.find((row) => row.status === 201)!.body.organizationId;
    const invitation = await invite(id).expect(201);
    const results = await Promise.all([accept(invitation.body.token), accept(invitation.body.token)]);
    expect(results.map((row) => row.status).sort()).toEqual([201, 410]);
    expect(await ctx.db.select().from(schema.organizationMemberships)).toHaveLength(2);
  });
  it('rejects suspended organizations and invitations from an owner whose access was revoked', async () => {
    const { id } = await approved();
    const invitation = await invite(id).expect(201);
    await ctx.db.update(schema.organizations).set({ status: 'SUSPENDED' }).where(eq(schema.organizations.id, id));
    await accept(invitation.body.token).expect(403);
    await ctx.http().get(`/v1/console/organizations/${id}`).set('Authorization', bearer('owner')).expect(403);
    await ctx.db.update(schema.organizations).set({ status: 'ACTIVE' }).where(eq(schema.organizations.id, id));
    await ctx.db
      .update(schema.organizationMemberships)
      .set({ status: 'INACTIVE' })
      .where(eq(schema.organizationMemberships.systemUserId, ids.owner));
    await accept(invitation.body.token).expect(403);
  });
  it('allows a System Admin tenant operations only through its own explicit membership', async () => {
    const { id } = await approved();
    const path = `/v1/console/organizations/${id}`;
    await ctx.http().get(path).set('Authorization', bearer('admin')).expect(403);
    await ctx.db
      .insert(schema.organizationMemberships)
      .values({ organizationId: id, systemUserId: ids.admin, role: 'BUSINESS_DEVELOPER' });
    expect((await ctx.http().get(path).set('Authorization', bearer('admin')).expect(200)).body.persona).toBe(
      'BUSINESS_DEVELOPER',
    );
    await ctx
      .http()
      .patch(`${path}/profile`)
      .set('Authorization', bearer('admin'))
      .send({ name: 'Not permitted' })
      .expect(403);
    await ctx.db
      .update(schema.organizationMemberships)
      .set({ role: 'OWNER' })
      .where(eq(schema.organizationMemberships.systemUserId, ids.admin));
    await ctx
      .http()
      .patch(`${path}/profile`)
      .set('Authorization', bearer('admin'))
      .send({ name: 'Explicit owner' })
      .expect(200);
    await ctx.db
      .update(schema.organizationMemberships)
      .set({ status: 'INACTIVE' })
      .where(eq(schema.organizationMemberships.systemUserId, ids.admin));
    await ctx.http().get(path).set('Authorization', bearer('admin')).expect(403);
  });
  it('validates the selected organization type and company/individual fields on the server', async () => {
    const base = { name: 'Business', slug: 'business' };
    const cases = [
      base,
      { ...base, organizationType: 'ADMIN' },
      { ...base, organizationType: 'INDIVIDUAL_HOUSEHOLD' },
      { ...base, organizationType: 'COMPANY' },
      { ...base, organizationType: 'COMPANY', legalName: 'Company', taxId: 'bad format!' },
      { ...base, organizationType: 'COMPANY', legalName: 'Company', taxId: '1234567890', nationalId: '000000000001' },
      { ...base, organizationType: 'INDIVIDUAL_HOUSEHOLD', representativeName: 'Owner', nationalId: '123' },
    ];
    for (const input of cases)
      await ctx
        .http()
        .post('/v1/console/organization-requests')
        .set('Authorization', bearer('owner'))
        .send(input)
        .expect(400);
    expect(await ctx.db.select().from(schema.organizations)).toEqual([]);
  });
  it('stores CCCD encrypted, masks it in responses and permits only an Owner to replace it', async () => {
    const nationalId = '000000000001';
    const input = {
      name: 'Household',
      slug: 'household',
      organizationType: 'INDIVIDUAL_HOUSEHOLD',
      representativeName: 'Legal Owner',
      nationalId,
    };
    const request = await ctx
      .http()
      .post('/v1/console/organization-requests')
      .set('Authorization', bearer('owner'))
      .send(input)
      .expect(201);
    const listed = await ctx
      .http()
      .get('/v1/console/organization-requests')
      .set('Authorization', bearer('owner'))
      .expect(200);
    expect(listed.body[0]).toMatchObject({
      organizationType: 'INDIVIDUAL_HOUSEHOLD',
      representativeName: 'Legal Owner',
      nationalIdLast4: '0001',
    });
    expect(JSON.stringify(listed.body)).not.toContain(nationalId);
    const [stored] = await ctx.db.select().from(schema.organizationIdentityDetails);
    expect(stored.nationalIdEncrypted).toMatch(/^v1\./);
    expect(stored.nationalIdEncrypted).not.toContain(nationalId);
    expect(JSON.stringify(await ctx.db.select().from(schema.organizationChangeRequests))).not.toContain(nationalId);
    await withRls(ctx.db, { userId: ids.owner }, async (tx) => {
      expect(await tx.select().from(schema.organizationIdentityDetails)).toEqual([]);
    });
    const approval = await ctx
      .http()
      .post(`/v1/platform/organization-requests/${request.body.id}/approve`).send({ reason: 'Reviewed application' })
      .set('Authorization', bearer('admin'))
      .send({})
      .expect(201);
    const id = approval.body.organizationId as string;
    const path = `/v1/console/organizations/${id}`;
    expect((await ctx.http().get(path).set('Authorization', bearer('owner')).expect(200)).body.nationalIdLast4).toBe(
      '0001',
    );
    const invitation = await invite(id).expect(201);
    await accept(invitation.body.token).expect(201);
    const developer = await ctx.http().get(path).set('Authorization', bearer('developer')).expect(200);
    expect(developer.body).not.toHaveProperty('nationalIdLast4');
    await ctx
      .http()
      .patch(`${path}/profile`)
      .set('Authorization', bearer('developer'))
      .send({ name: 'Household', nationalId: '000000000002' })
      .expect(403);
    await ctx
      .http()
      .patch(`${path}/profile`)
      .set('Authorization', bearer('owner'))
      .send({ name: 'Household', nationalId: '000000000002' })
      .expect(200);
    expect((await ctx.http().get(path).set('Authorization', bearer('owner')).expect(200)).body.nationalIdLast4).toBe(
      '0002',
    );
    const [updated] = await ctx.db.select().from(schema.organizationIdentityDetails);
    expect(updated.nationalIdEncrypted).not.toBe(stored.nationalIdEncrypted);
    await ctx
      .http()
      .patch(`${path}/profile`)
      .set('Authorization', bearer('owner'))
      .send({ name: 'Household', nationalId: 'bad' })
      .expect(400);
  });
  it('persists a company registration and prevents clearing required details or changing its type', async () => {
    const request = await ctx
      .http()
      .post('/v1/console/organization-requests')
      .set('Authorization', bearer('owner'))
      .send({
        name: 'Brand',
        slug: 'company',
        organizationType: 'COMPANY',
        legalName: 'Registered Company',
        taxId: '0123456789',
      })
      .expect(201);
    expect(
      (await ctx.http().get('/v1/platform/organization-requests').set('Authorization', bearer('admin')).expect(200))
        .body[0],
    ).toMatchObject({ organizationType: 'COMPANY', legalName: 'Registered Company', taxId: '0123456789' });
    const approval = await ctx
      .http()
      .post(`/v1/platform/organization-requests/${request.body.id}/approve`).send({ reason: 'Reviewed application' })
      .set('Authorization', bearer('admin'))
      .send({})
      .expect(201);
    const path = `/v1/console/organizations/${approval.body.organizationId}/profile`;
    for (const input of [
      { name: 'Brand', taxId: '' },
      { name: 'Brand', legalName: '' },
      { name: 'Brand', organizationType: 'INDIVIDUAL_HOUSEHOLD' },
      { name: 'Brand', nationalId: '000000000001' },
    ])
      await ctx.http().patch(path).set('Authorization', bearer('owner')).send(input).expect(400);
    expect(await ctx.db.select().from(schema.organizationIdentityDetails)).toEqual([]);
  });
  it('can classify an existing legacy organization once without guessing during migration', async () => {
    const org = await seedOrganization(ctx.db);
    await ctx.db
      .insert(schema.organizationMemberships)
      .values({ organizationId: org.id, systemUserId: ids.owner, role: 'OWNER' });
    const path = `/v1/console/organizations/${org.id}`;
    expect(
      (await ctx.http().get(path).set('Authorization', bearer('owner')).expect(200)).body.organizationType,
    ).toBeNull();
    await ctx
      .http()
      .patch(`${path}/profile`)
      .set('Authorization', bearer('owner'))
      .send({ name: org.name, organizationType: 'INDIVIDUAL_HOUSEHOLD' })
      .expect(400);
    await ctx
      .http()
      .patch(`${path}/profile`)
      .set('Authorization', bearer('owner'))
      .send({
        name: org.name,
        organizationType: 'INDIVIDUAL_HOUSEHOLD',
        representativeName: 'Owner',
        nationalId: '000000000001',
      })
      .expect(200);
    expect((await ctx.http().get(path).set('Authorization', bearer('owner')).expect(200)).body).toMatchObject({
      organizationType: 'INDIVIDUAL_HOUSEHOLD',
      nationalIdLast4: '0001',
    });
    await ctx
      .http()
      .patch(`${path}/profile`)
      .set('Authorization', bearer('owner'))
      .send({ name: org.name, organizationType: 'WRONG' })
      .expect(400);
  });
  it('fails closed without an encryption key and rolls back the entire CCCD submission', async () => {
    vi.stubEnv('ORGANIZATION_IDENTITY_ENCRYPTION_KEY', '');
    await ctx
      .http()
      .post('/v1/console/organization-requests')
      .set('Authorization', bearer('owner'))
      .send({
        name: 'Household',
        slug: 'household',
        organizationType: 'INDIVIDUAL_HOUSEHOLD',
        representativeName: 'Owner',
        nationalId: '000000000001',
      })
      .expect(503);
    expect(await ctx.db.select().from(schema.organizations)).toEqual([]);
    expect(await ctx.db.select().from(schema.organizationChangeRequests)).toEqual([]);
  });
});
