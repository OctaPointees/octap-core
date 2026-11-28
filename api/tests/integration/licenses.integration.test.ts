import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTenant } from '#infra/db/rls.js';
import { createTestApp } from './support/app.js';
import {
  resetDb,
  schema,
  seedCredential,
  seedLicense,
  seedLicensePlans,
  seedMember,
  seedOrganization,
} from './support/db.js';
import { takeLicenseTransaction } from '#infra/db/repositories/license-enforcement.js';

describe('licenses (OCT-329, part 1)', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let orgId: string;
  let ids: Record<string, string>;
  let plans: Awaited<ReturnType<typeof seedLicensePlans>>;
  const bearer = (actor: string) => `Bearer ${actor}`;
  const consoleRoute = () => `/v1/console/organizations/${orgId}/license`;
  const platformRoute = () => `/v1/platform/organizations/${orgId}/license`;

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
    plans = await seedLicensePlans(ctx.db);
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

  describe('reading a license', () => {
    it('shows it to the Owner, Business Developers, the System Admin and read keys, and no one else', async () => {
      const startsAt = new Date(Date.now() - 86_400_000);
      const endsAt = new Date(Date.now() + 10 * 86_400_000);
      await seedLicense(ctx.db, orgId, plans.GROWTH, { startsAt, endsAt });
      const expected = {
        organizationId: orgId,
        license: {
          tier: 'GROWTH',
          planName: 'Growth',
          planId: plans.GROWTH.id,
          source: 'ADMIN',
          state: 'ACTIVE',
          daysLeft: 10,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          graceEndsAt: new Date(endsAt.getTime() + 7 * 86_400_000).toISOString(),
          entitlements: plans.GROWTH.entitlements,
        },
      };
      for (const actor of ['owner', 'developer']) {
        const res = await ctx.http().get(consoleRoute()).set('Authorization', bearer(actor)).expect(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body).toMatchObject(expected);
      }
      await ctx.http().get(consoleRoute()).set('Authorization', bearer('outsider')).expect(403);
      await ctx.http().get(platformRoute()).set('Authorization', bearer('admin')).expect(200);
      await ctx.http().get(platformRoute()).set('Authorization', bearer('owner')).expect(403);

      const { rawKey } = await seedCredential(ctx.db, orgId, { scopes: ['read'] });
      const res = await ctx.http().get('/v1/license').set('Authorization', `Bearer ${rawKey}`).expect(200);
      expect(res.body).toMatchObject(expected);
      const writeOnly = await seedCredential(ctx.db, orgId, { scopes: ['write'] });
      await ctx.http().get('/v1/license').set('Authorization', `Bearer ${writeOnly.rawKey}`).expect(403);
    });

    it('answers license: null for an organization that has none', async () => {
      const res = await ctx.http().get(consoleRoute()).set('Authorization', bearer('owner')).expect(200);
      expect(res.body).toEqual({ organizationId: orgId, license: null, usage: null });
    });

    it('works out GRACE and EXPIRED from the dates, and reads the latest license that has started', async () => {
      const day = 86_400_000;
      await seedLicense(ctx.db, orgId, plans.TRIAL, {
        startsAt: new Date(Date.now() - 30 * day),
        endsAt: new Date(Date.now() - 16 * day),
      });
      const read = async () =>
        (await ctx.http().get(consoleRoute()).set('Authorization', bearer('owner')).expect(200)).body.license;
      expect(await read()).toMatchObject({ tier: 'TRIAL', state: 'EXPIRED', daysLeft: 0 });

      await seedLicense(ctx.db, orgId, plans.STARTER, {
        startsAt: new Date(Date.now() - 10 * day),
        endsAt: new Date(Date.now() - 2 * day),
      });
      expect(await read()).toMatchObject({ tier: 'STARTER', state: 'GRACE', daysLeft: 0 });

      // One bought for later doesn't count until it starts.
      await seedLicense(ctx.db, orgId, plans.GROWTH, {
        startsAt: new Date(Date.now() + 5 * day),
        endsAt: new Date(Date.now() + 40 * day),
      });
      expect(await read()).toMatchObject({ tier: 'STARTER' });
    });

    it('counts usage: this license month’s accepted transactions, members, active keys and team', async () => {
      const startsAt = new Date(Date.now() - 40 * 86_400_000);
      await seedLicense(ctx.db, orgId, plans.STARTER, { startsAt, endsAt: new Date(Date.now() + 50 * 86_400_000) });
      await seedMember(ctx.db, orgId);
      await seedMember(ctx.db, orgId);
      // Neither counts: one is suspended here, the other blocked everywhere.
      const suspended = await seedMember(ctx.db, orgId);
      await ctx.db
        .update(schema.organizationEndUsers)
        .set({ status: 'SUSPENDED' })
        .where(eq(schema.organizationEndUsers.id, suspended.memberId));
      const blocked = await seedMember(ctx.db, orgId);
      await ctx.db.update(schema.endUsers).set({ status: 'BLOCKED' }).where(eq(schema.endUsers.id, blocked.endUser.id));
      // The counter earn, POS reserve and paid claims take from (part 2); last month's doesn't count.
      await takeLicenseTransaction(ctx.db, orgId, new Date(Date.now() - 35 * 86_400_000));
      await takeLicenseTransaction(ctx.db, orgId);
      await takeLicenseTransaction(ctx.db, orgId);
      await seedCredential(ctx.db, orgId);
      await seedCredential(ctx.db, orgId, { status: 'REVOKED' });

      const { usage } = (await ctx.http().get(consoleRoute()).set('Authorization', bearer('owner')).expect(200)).body;
      expect(usage).toMatchObject({ transactionsMonthly: 2, members: 2, apiKeys: 1, teamMembers: 2 });
      expect(Date.parse(usage.periodStart)).toBeLessThanOrEqual(Date.now());
      expect(Date.parse(usage.periodEnd)).toBeGreaterThan(Date.now());
    });

    it("ends a short license's month at its end, and answers 404 to the System Admin for an unknown organization", async () => {
      const startsAt = new Date();
      const trial = await seedLicense(ctx.db, orgId, plans.TRIAL, {
        startsAt,
        endsAt: new Date(startsAt.getTime() + 14 * 86_400_000),
      });
      const { usage } = (await ctx.http().get(consoleRoute()).set('Authorization', bearer('owner')).expect(200)).body;
      expect(usage.periodEnd).toBe(trial.endsAt.toISOString());

      await ctx
        .http()
        .get('/v1/platform/organizations/00000000-0000-4000-8000-000000000000/license')
        .set('Authorization', bearer('admin'))
        .expect(404);
    });

    it("keeps one organization's license out of another's reach under RLS", async () => {
      await seedLicense(ctx.db, orgId, plans.GROWTH);
      const other = await seedOrganization(ctx.db);
      const visible = await withTenant(ctx.db, other.id, (tx) => tx.select().from(schema.licenses));
      expect(visible).toEqual([]);
      const own = await withTenant(ctx.db, orgId, (tx) => tx.select().from(schema.licenses));
      expect(own).toHaveLength(1);
    });
  });

  describe('the plan catalogue', () => {
    const platform = (actor = 'admin') => ({
      list: () => ctx.http().get('/v1/platform/license-plans').set('Authorization', bearer(actor)),
      create: (body: unknown) =>
        ctx
          .http()
          .post('/v1/platform/license-plans')
          .set('Authorization', bearer(actor))
          .send(body as object),
      update: (id: string, body: unknown) =>
        ctx
          .http()
          .patch(`/v1/platform/license-plans/${id}`)
          .set('Authorization', bearer(actor))
          .send(body as object),
    });

    it('shows Owners only the plans on sale, and the System Admin all of them', async () => {
      const offered = await ctx
        .http()
        .get('/v1/console/license-plans')
        .set('Authorization', bearer('owner'))
        .expect(200);
      expect(offered.body.map((plan: { tier: string }) => plan.tier)).toEqual(['STARTER', 'GROWTH']);
      const all = await platform().list().expect(200);
      expect(all.body).toHaveLength(4);
      await platform('owner').list().expect(403);
    });

    it('lets only the System Admin create and edit plans, and editing never changes a license already granted', async () => {
      const body = {
        tier: 'STARTER',
        name: 'Starter Plus',
        monthlyPriceVnd: 1_490_000,
        termMonthsAllowed: [12, 6],
        entitlements: {
          features: ['webhooks'],
          limits: { transactionsMonthly: 20_000, members: 8000, apiKeys: 3, teamMembers: 5 },
        },
      };
      await platform('owner').create(body).expect(403);
      const created = (await platform().create(body).expect(201)).body;
      expect(created).toMatchObject({
        name: 'Starter Plus',
        termMonthsAllowed: [6, 12],
        purchasable: true,
        active: true,
      });

      await seedLicense(ctx.db, orgId, plans.STARTER);
      const edited = await platform()
        .update(plans.STARTER.id, {
          monthlyPriceVnd: 1_190_000,
          entitlements: { ...plans.STARTER.entitlements, features: ['webhooks', 'mcp'] },
        })
        .expect(200);
      expect(edited.body).toMatchObject({ monthlyPriceVnd: 1_190_000 });
      const license = (await ctx.http().get(consoleRoute()).set('Authorization', bearer('owner')).expect(200)).body
        .license;
      expect(license.entitlements).toEqual(plans.STARTER.entitlements);

      // Retired, not deleted: still there for the System Admin, no longer on sale.
      await platform().update(plans.STARTER.id, { active: false }).expect(200);
      const offered = await ctx.http().get('/v1/console/license-plans').set('Authorization', bearer('owner'));
      expect(offered.body.map((plan: { id: string }) => plan.id)).not.toContain(plans.STARTER.id);
    });

    it('refuses a plan it cannot use (400) and an unknown one (404)', async () => {
      // Required fields are the controller's check; the rest is the service's.
      const missing = await platform().create({ tier: 'STARTER', name: 'X' }).expect(400);
      expect(missing.body.message).toBe('monthlyPriceVnd is required');
      await platform().create(['not', 'an', 'object']).expect(400);
      await platform()
        .create({
          tier: 'STARTER',
          name: 'X',
          monthlyPriceVnd: 1,
          entitlements: { features: ['teleport'], limits: {} },
        })
        .expect(400);
      await platform().update(plans.GROWTH.id, { tier: 'TRIAL' }).expect(400);
      await platform().update(plans.GROWTH.id, { termMonthsAllowed: [] }).expect(400);
      await platform().update('00000000-0000-4000-8000-000000000000', { name: 'Nope' }).expect(404);
    });
  });

  describe('where licenses come from', () => {
    const apply = () =>
      ctx.http().post('/v1/console/organization-requests').set('Authorization', bearer('owner')).send({
        name: 'New Business',
        slug: 'new-business',
        organizationType: 'INDIVIDUAL_HOUSEHOLD',
        representativeName: 'Business Owner',
      });

    it('grants the trial when the System Admin approves an organization, in the same transaction', async () => {
      const request = await apply().expect(201);
      const approval = await ctx
        .http()
        .post(`/v1/platform/organization-requests/${request.body.id}/approve`)
        .set('Authorization', bearer('admin'))
        .send({ reason: 'Reviewed application' })
        .expect(201);
      const id = approval.body.organizationId as string;
      const res = await ctx
        .http()
        .get(`/v1/console/organizations/${id}/license`)
        .set('Authorization', bearer('owner'))
        .expect(200);
      expect(res.body.license).toMatchObject({ tier: 'TRIAL', source: 'TRIAL', state: 'ACTIVE', daysLeft: 14 });
      expect(Date.parse(res.body.license.endsAt) - Date.parse(res.body.license.startsAt)).toBe(14 * 86_400_000);
    });

    it('keeps a license the organization already has instead of granting a trial over it', async () => {
      const request = await apply().expect(201);
      const [row] = await ctx.db
        .select()
        .from(schema.organizationChangeRequests)
        .where(eq(schema.organizationChangeRequests.id, request.body.id));
      // What the migration gives an organization, or a System Admin grants before approval.
      await seedLicense(ctx.db, row.organizationId!, plans.GROWTH);
      await ctx
        .http()
        .post(`/v1/platform/organization-requests/${request.body.id}/approve`)
        .set('Authorization', bearer('admin'))
        .send({ reason: 'Reviewed application' })
        .expect(201);
      const granted = await ctx.db.select().from(schema.licenses);
      expect(granted.map((license) => license.tier)).toEqual(['GROWTH']);
    });

    it('grants the newest active trial plan', async () => {
      const [newer] = await ctx.db
        .insert(schema.licensePlans)
        .values({
          ...plans.TRIAL,
          id: undefined,
          name: 'Trial 30',
          durationDays: 30,
          createdAt: new Date(Date.now() + 1000),
        })
        .returning();
      const request = await apply().expect(201);
      await ctx
        .http()
        .post(`/v1/platform/organization-requests/${request.body.id}/approve`)
        .set('Authorization', bearer('admin'))
        .send({ reason: 'Reviewed application' })
        .expect(201);
      const [granted] = await ctx.db.select().from(schema.licenses);
      expect(granted).toMatchObject({ planId: newer.id, planName: 'Trial 30' });
    });

    it('approves without a license while the catalogue has no active trial', async () => {
      await ctx.db.update(schema.licensePlans).set({ active: false }).where(eq(schema.licensePlans.tier, 'TRIAL'));
      const request = await apply().expect(201);
      await ctx
        .http()
        .post(`/v1/platform/organization-requests/${request.body.id}/approve`)
        .set('Authorization', bearer('admin'))
        .send({ reason: 'Reviewed application' })
        .expect(201);
      expect(await ctx.db.select().from(schema.licenses)).toEqual([]);
    });
  });
});
