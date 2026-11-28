import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { LicensesRepository } from '#infra/db/repositories/licenses.repository.js';
import { addMonths } from '#infra/db/repositories/license-period.js';
import { createTestApp } from './support/app.js';
import {
  eventsOfType,
  resetDb,
  schema,
  seedCredential,
  seedLicense,
  seedLicensePlans,
  seedMember,
  seedOrganization,
  seedProgram,
} from './support/db.js';

const DAY = 86_400_000;
const days = (from: Date, n: number) => new Date(from.getTime() + n * DAY);

describe('license expiry (OCT-329, part 3)', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let orgId: string;
  let plans: Awaited<ReturnType<typeof seedLicensePlans>>;
  const bearer = (actor: string) => ({ Authorization: `Bearer ${actor}` });
  const repo = () => ctx.app.get(LicensesRepository, { strict: false });
  const notices = async () =>
    (await eventsOfType(ctx.db, 'license.expiry_notice')).map((event) => event.payload as { stage: string });

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
    orgId = (await seedOrganization(ctx.db)).id;
  });

  describe('expiry notices', () => {
    it('sends each step once, in order: 30, 7 and 1 days left, grace, expired', async () => {
      const startsAt = new Date();
      const license = await seedLicense(ctx.db, orgId, plans.GROWTH, { startsAt, endsAt: days(startsAt, 90) });
      const at = (n: number) => repo().recordExpiryNotices(days(startsAt, n));

      expect(await at(59)).toBe(0); // 31 days left
      expect(await at(61)).toBe(1);
      expect(await at(62)).toBe(0); // still the same step
      expect(await at(84)).toBe(1);
      expect(await at(89.5)).toBe(1);
      expect(await at(90.1)).toBe(1);
      expect(await at(96)).toBe(0); // grace lasts 7 days
      expect(await at(97.1)).toBe(1);
      expect(await at(120)).toBe(0);

      const sent = await eventsOfType(ctx.db, 'license.expiry_notice');
      expect(sent.map((event) => (event.payload as { stage: string }).stage)).toEqual([
        'DAYS_30',
        'DAYS_7',
        'DAYS_1',
        'GRACE',
        'EXPIRED',
      ]);
      expect(sent[0]).toMatchObject({
        organizationId: orgId,
        payload: {
          licenseId: license.id,
          tier: 'GROWTH',
          planName: plans.GROWTH.name,
          endsAt: license.endsAt.toISOString(),
          graceEndsAt: days(license.endsAt, 7).toISOString(),
          daysLeft: 29,
        },
      });
    });

    it('sends only the current step when several passed unseen', async () => {
      const now = new Date();
      await seedLicense(ctx.db, orgId, plans.GROWTH, { startsAt: days(now, -100), endsAt: days(now, -10) });
      expect(await repo().recordExpiryNotices(now)).toBe(1);
      expect(await notices()).toEqual([expect.objectContaining({ stage: 'EXPIRED' })]);
    });

    it('skips a reminder longer than the license: a 14-day trial is not told "30 days left"', async () => {
      const startsAt = new Date();
      await seedLicense(ctx.db, orgId, plans.TRIAL, { startsAt, endsAt: days(startsAt, 14) });
      expect(await repo().recordExpiryNotices(startsAt)).toBe(0);
      expect(await repo().recordExpiryNotices(days(startsAt, 8))).toBe(1);
      expect(await notices()).toEqual([expect.objectContaining({ stage: 'DAYS_7' })]);
    });

    it('says nothing about a license already renewed', async () => {
      const now = new Date();
      const old = await seedLicense(ctx.db, orgId, plans.GROWTH, { startsAt: days(now, -85), endsAt: days(now, 5) });
      await seedLicense(ctx.db, orgId, plans.GROWTH, { startsAt: old.endsAt, endsAt: addMonths(old.endsAt, 3) });
      expect(await repo().recordExpiryNotices(now)).toBe(0);
      expect(await repo().recordExpiryNotices(days(now, 10))).toBe(0);
    });

    it('records a step once when two passes run at once', async () => {
      const now = new Date();
      for (let i = 0; i < 5; i += 1) {
        const other = (await seedOrganization(ctx.db)).id;
        await seedLicense(ctx.db, other, plans.GROWTH, { startsAt: days(now, -80), endsAt: days(now, 3) });
      }
      const [a, b] = await Promise.all([repo().recordExpiryNotices(now), repo().recordExpiryNotices(now)]);
      expect(a + b).toBe(5);
      expect(await notices()).toHaveLength(5);
    });

    it('leaves archived organizations alone', async () => {
      const now = new Date();
      await seedLicense(ctx.db, orgId, plans.GROWTH, { startsAt: days(now, -80), endsAt: days(now, 3) });
      await ctx.db.update(schema.organizations).set({ status: 'ARCHIVED' }).where(eq(schema.organizations.id, orgId));
      expect(await repo().recordExpiryNotices(now)).toBe(0);
    });
  });

  describe('an expired license', () => {
    let memberId: string;
    let key: { authorization: string };
    const earn = (idempotencyKey: string) =>
      ctx
        .http()
        .post('/v1/credits/earn')
        .set(key)
        .send({ organizationEndUserId: memberId, purchaseAmount: 10_000, idempotencyKey });

    beforeEach(async () => {
      await seedProgram(ctx.db, orgId);
      memberId = (await seedMember(ctx.db, orgId)).memberId;
      key = { authorization: `Bearer ${(await seedCredential(ctx.db, orgId)).rawKey}` };
    });

    it('still accepts transactions during the grace period', async () => {
      const now = new Date();
      await seedLicense(ctx.db, orgId, plans.GROWTH, { startsAt: days(now, -92), endsAt: days(now, -2) });
      await earn('in-grace').expect(201);
    });

    it('refuses new transactions with 402, and nothing else', async () => {
      const now = new Date();
      await seedLicense(ctx.db, orgId, plans.GROWTH, { startsAt: days(now, -100), endsAt: days(now, -10) });
      const refused = await earn('after-grace').expect(402);
      expect(refused.body).toMatchObject({ statusCode: 402, code: 'LICENSE_EXPIRED' });
      expect(await ctx.db.select().from(schema.loyaltyTransactions)).toEqual([]);

      // Reads keep working: balances, transactions and the voucher catalog.
      await ctx.http().get(`/v1/credits/members/${memberId}/balance`).set(key).expect(200);
      await ctx.http().get(`/v1/credits/members/${memberId}/transactions`).set(key).expect(200);
      await ctx.http().get('/v1/rewards/vouchers').set(key).expect(200);
      expect((await ctx.http().get('/v1/license').set(key).expect(200)).body.license.state).toBe('EXPIRED');
    });
  });

  describe('renewal', () => {
    const renew = (body: object, actor = 'admin', organizationId = orgId) =>
      ctx.http().post(`/v1/platform/organizations/${organizationId}/license`).set(bearer(actor)).send(body);
    const licenses = () =>
      ctx.db
        .select()
        .from(schema.licenses)
        .where(eq(schema.licenses.organizationId, orgId))
        .orderBy(schema.licenses.startsAt);

    beforeEach(async () => {
      for (const actor of ['admin', 'owner']) {
        const id = (await ctx.http().post('/v1/console/auth/google').send({ idToken: actor })).body.user.id;
        if (actor === 'admin')
          await ctx.db
            .update(schema.systemUsers)
            .set({ systemRole: 'SYSTEM_ADMIN' })
            .where(eq(schema.systemUsers.id, id));
        else
          await ctx.db
            .insert(schema.organizationMemberships)
            .values({ organizationId: orgId, systemUserId: id, role: 'OWNER' });
      }
    });

    it.each([
      ['active', 10],
      ['in grace', -3],
    ])('follows a license that is %s from its end', async (_label, endsIn) => {
      const now = new Date();
      const current = await seedLicense(ctx.db, orgId, plans.STARTER, {
        startsAt: days(now, endsIn - 90),
        endsAt: days(now, endsIn),
      });
      const res = await renew({ planId: plans.GROWTH.id, months: 3 }).expect(201);
      const [, renewed] = await licenses();
      expect(renewed).toMatchObject({ tier: 'GROWTH', source: 'ADMIN', startsAt: current.endsAt });
      expect(renewed.endsAt).toEqual(addMonths(current.endsAt, 3));
      expect(renewed.entitlements).toEqual(plans.GROWTH.entitlements);
      // In grace the renewal is in force at once; while active, the current one still is.
      expect(res.body.license.id).toBe(endsIn < 0 ? renewed.id : current.id);
    });

    it('starts now once the license has expired, and transactions work again', async () => {
      const now = new Date();
      await seedLicense(ctx.db, orgId, plans.GROWTH, { startsAt: days(now, -100), endsAt: days(now, -10) });
      const res = await renew({ planId: plans.GROWTH.id, months: 1 }).expect(201);
      expect(res.body.license.state).toBe('ACTIVE');
      const [, renewed] = await licenses();
      expect(Math.abs(renewed.startsAt.getTime() - Date.now())).toBeLessThan(60_000);

      await seedProgram(ctx.db, orgId);
      const memberId = (await seedMember(ctx.db, orgId)).memberId;
      const { rawKey } = await seedCredential(ctx.db, orgId);
      await ctx
        .http()
        .post('/v1/credits/earn')
        .set('Authorization', `Bearer ${rawKey}`)
        .send({ organizationEndUserId: memberId, purchaseAmount: 10_000, idempotencyKey: 'renewed' })
        .expect(201);
    });

    it('chains renewals made one after the other, and starts now without any license', async () => {
      await renew({ planId: plans.STARTER.id, months: 3 }).expect(201);
      await renew({ planId: plans.STARTER.id, months: 3 }).expect(201);
      const [first, second] = await licenses();
      expect(second.startsAt).toEqual(first.endsAt);
    });

    it('waits for a renewal in progress and follows it, instead of overlapping it', async () => {
      // A first renewal holds the organization's row and has just written its license, not committed.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let held!: () => void;
      const holding = new Promise<void>((resolve) => (held = resolve));
      const now = new Date();
      const first = ctx.db.transaction(async (tx) => {
        await tx.select().from(schema.organizations).where(eq(schema.organizations.id, orgId)).for('update');
        await tx.insert(schema.licenses).values({
          organizationId: orgId,
          planId: plans.STARTER.id,
          tier: 'STARTER',
          planName: plans.STARTER.name,
          entitlements: plans.STARTER.entitlements,
          source: 'ADMIN',
          startsAt: now,
          endsAt: addMonths(now, 1),
        });
        held();
        await gate;
      });
      await holding;
      const second = repo().renew({ organizationId: orgId, plan: plans.STARTER, months: 1, source: 'ADMIN', now });
      await new Promise((resolve) => setTimeout(resolve, 200));
      release();
      await first;
      await second;
      const [one, two] = await licenses();
      expect(two.startsAt).toEqual(one.endsAt);
    });

    it('is for the System Admin only, with a valid active plan and term', async () => {
      await renew({ planId: plans.GROWTH.id, months: 3 }, 'owner').expect(403);
      await renew({ planId: plans.GROWTH.id, months: 0 }).expect(400);
      await renew({ planId: plans.GROWTH.id, months: 37 }).expect(400);
      await renew({ planId: plans.GROWTH.id, months: 3, extra: true }).expect(400);
      await renew({ planId: 'not-a-uuid', months: 3 }).expect(400);
      await renew({ planId: plans.TRIAL.id, months: 1 }).expect(400);
      await ctx.db
        .update(schema.licensePlans)
        .set({ active: false })
        .where(eq(schema.licensePlans.id, plans.STARTER.id));
      await renew({ planId: plans.STARTER.id, months: 3 }).expect(400);
      await renew({ planId: plans.GROWTH.id, months: 3 }, 'admin', '00000000-0000-4000-8000-000000000000').expect(404);
      expect(await licenses()).toEqual([]);
    });
  });
});
