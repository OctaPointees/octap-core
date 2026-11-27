import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withTenant } from '#infra/db/rls.js';
import { createTestApp } from './support/app.js';
import { resetDb, schema, seedLicensePlans, seedOrganization } from './support/db.js';

const HOUR = 3_600_000;

describe('license orders (OCT-330, part 1)', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let orgId: string;
  let otherOrgId: string;
  let plans: Awaited<ReturnType<typeof seedLicensePlans>>;
  const bearer = (actor: string) => ({ Authorization: `Bearer ${actor}` });
  const route = (organizationId = orgId) => `/v1/console/organizations/${organizationId}/license/orders`;
  const place = (body: unknown, actor = 'owner', organizationId = orgId) =>
    ctx
      .http()
      .post(route(organizationId))
      .set(bearer(actor))
      .send(body as object);
  const rows = () => ctx.db.select().from(schema.licenseOrders).orderBy(schema.licenseOrders.createdAt);

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
    vi.stubEnv('SEPAY_BANK_ACCOUNT', '0123456789');
    vi.stubEnv('SEPAY_BANK_CODE', 'MBBank');
    await resetDb(ctx.db);
    plans = await seedLicensePlans(ctx.db);
    orgId = (await seedOrganization(ctx.db)).id;
    otherOrgId = (await seedOrganization(ctx.db)).id;
    for (const actor of ['owner', 'developer', 'outsider', 'other']) {
      const id = (await ctx.http().post('/v1/console/auth/google').send({ idToken: actor })).body.user.id;
      if (actor === 'owner' || actor === 'developer')
        await ctx.db.insert(schema.organizationMemberships).values({
          organizationId: orgId,
          systemUserId: id,
          role: actor === 'owner' ? 'OWNER' : 'BUSINESS_DEVELOPER',
        });
      if (actor === 'other')
        await ctx.db
          .insert(schema.organizationMemberships)
          .values({ organizationId: otherOrgId, systemUserId: id, role: 'OWNER' });
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prices the order from the plan and gives a VietQR code for exactly that amount', async () => {
    const res = await place({ planId: plans.STARTER.id, termMonths: 3 }).expect(201);
    expect(res.body).toMatchObject({
      organizationId: orgId,
      planId: plans.STARTER.id,
      tier: 'STARTER',
      planName: 'Starter',
      termMonths: 3,
      amountVnd: 2_970_000,
      state: 'PENDING',
      bankAccount: '0123456789',
      bankCode: 'MBBank',
      paidAt: null,
    });
    expect(res.body.paymentCode).toMatch(/^OCTAP\d{8}$/);
    const qr = new URL(res.body.qrUrl);
    expect(qr.origin + qr.pathname).toBe('https://qr.sepay.vn/img');
    expect(Object.fromEntries(qr.searchParams)).toEqual({
      acc: '0123456789',
      bank: 'MBBank',
      amount: '2970000',
      des: res.body.paymentCode,
    });
    expect(Date.parse(res.body.expiresAt) - Date.now()).toBeGreaterThan(23.9 * HOUR);
    expect(Date.parse(res.body.expiresAt) - Date.now()).toBeLessThanOrEqual(24 * HOUR);
    const [stored] = await rows();
    expect(stored).toMatchObject({ amountVnd: 2_970_000, status: 'PENDING', paymentCode: res.body.paymentCode });
  });

  it('never takes the amount, or anything else, from the request', async () => {
    const refused = await place({ planId: plans.STARTER.id, termMonths: 3, amountVnd: 1 }).expect(400);
    expect(refused.body.message).toBe('Unknown field: amountVnd');
    await place({ planId: plans.STARTER.id, termMonths: 3, amount: 1 }).expect(400);
    await place({ planId: 'not-a-uuid', termMonths: 3 }).expect(400);
    await place({ planId: plans.STARTER.id, termMonths: 2.5 }).expect(400);
    await place({ planId: plans.STARTER.id }).expect(400);
    await place(['planId']).expect(400);
    expect(await rows()).toEqual([]);
  });

  it('sells only plans on sale, for one of their terms', async () => {
    await place({ planId: plans.STARTER.id, termMonths: 2 }).expect(400);
    await place({ planId: plans.ENTERPRISE.id, termMonths: 12 }).expect(400);
    await place({ planId: plans.TRIAL.id, termMonths: 1 }).expect(400);
    await ctx.db.update(schema.licensePlans).set({ active: false }).where(eq(schema.licensePlans.id, plans.GROWTH.id));
    await place({ planId: plans.GROWTH.id, termMonths: 3 }).expect(400);
    await place({ planId: '00000000-0000-4000-8000-000000000000', termMonths: 3 }).expect(400);
    expect(await rows()).toEqual([]);
  });

  it('is for the Owner only, of an active organization', async () => {
    const body = { planId: plans.STARTER.id, termMonths: 3 };
    await place(body, 'developer').expect(403);
    await place(body, 'outsider').expect(403);
    await ctx.http().get(route()).set(bearer('developer')).expect(403);
    await ctx.db.update(schema.organizations).set({ status: 'SUSPENDED' }).where(eq(schema.organizations.id, orgId));
    await place(body).expect(403);
    expect(await rows()).toEqual([]);
  });

  it('keeps one order to pay: the same choice returns it, another one replaces it', async () => {
    const first = (await place({ planId: plans.STARTER.id, termMonths: 3 }).expect(201)).body;
    const again = (await place({ planId: plans.STARTER.id, termMonths: 3 }).expect(201)).body;
    expect(again.id).toBe(first.id);
    expect(again.paymentCode).toBe(first.paymentCode);

    const other = (await place({ planId: plans.GROWTH.id, termMonths: 6 }).expect(201)).body;
    expect(other.id).not.toBe(first.id);
    expect(other.amountVnd).toBe(2_990_000 * 6);
    const list = (await ctx.http().get(route()).set(bearer('owner')).expect(200)).body;
    expect(list.map((order: { id: string; state: string }) => [order.id, order.state])).toEqual([
      [other.id, 'PENDING'],
      [first.id, 'CANCELED'],
    ]);
  });

  it('queues two orders made at once, so only one stays to be paid', async () => {
    // Another order is being placed: it holds the organization's row, as the Owner check does.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const first = ctx.db.transaction(async (tx) => {
      await tx.select().from(schema.organizations).where(eq(schema.organizations.id, orgId)).for('update');
      held();
      await gate;
    });
    await holding;
    const both = Promise.all([
      place({ planId: plans.STARTER.id, termMonths: 3 }),
      place({ planId: plans.GROWTH.id, termMonths: 3 }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await first;
    const results = await both;
    expect(results.map((res) => res.status)).toEqual([201, 201]);
    const pending = (await rows()).filter((order) => order.status === 'PENDING');
    expect(pending).toHaveLength(1);
  });

  it('expires an order after 24 hours, and a new one can be placed', async () => {
    const first = (await place({ planId: plans.STARTER.id, termMonths: 3 }).expect(201)).body;
    await ctx.db
      .update(schema.licenseOrders)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.licenseOrders.id, first.id));
    const read = (await ctx.http().get(`${route()}/${first.id}`).set(bearer('owner')).expect(200)).body;
    expect(read.state).toBe('EXPIRED');
    const fresh = (await place({ planId: plans.STARTER.id, termMonths: 3 }).expect(201)).body;
    expect(fresh.id).not.toBe(first.id);
    expect(fresh.paymentCode).not.toBe(first.paymentCode);
  });

  it('cancels a pending order once, and never a paid one', async () => {
    const order = (await place({ planId: plans.STARTER.id, termMonths: 3 }).expect(201)).body;
    const cancel = (id: string, actor = 'owner') =>
      ctx.http().post(`${route()}/${id}/cancel`).set(bearer(actor)).send({});
    await cancel(order.id, 'developer').expect(403);
    expect((await cancel(order.id).expect(201)).body.state).toBe('CANCELED');
    expect((await cancel(order.id).expect(409)).body.message).toBe('This order is already canceled');

    const paid = (await place({ planId: plans.GROWTH.id, termMonths: 3 }).expect(201)).body;
    await ctx.db
      .update(schema.licenseOrders)
      .set({ status: 'PAID', paidAt: new Date() })
      .where(eq(schema.licenseOrders.id, paid.id));
    expect((await cancel(paid.id).expect(409)).body.message).toBe('This order is already paid');
    await cancel('00000000-0000-4000-8000-000000000000').expect(404);
  });

  it("keeps one organization's orders out of another's reach", async () => {
    const order = (await place({ planId: plans.STARTER.id, termMonths: 3 }).expect(201)).body;
    // The other organization's Owner, on their own organization's route.
    await ctx
      .http()
      .get(`${route(otherOrgId)}/${order.id}`)
      .set(bearer('other'))
      .expect(404);
    expect((await ctx.http().get(route(otherOrgId)).set(bearer('other')).expect(200)).body).toEqual([]);
    await ctx
      .http()
      .post(`${route(otherOrgId)}/${order.id}/cancel`)
      .set(bearer('other'))
      .send({})
      .expect(404);
    const visible = await withTenant(ctx.db, otherOrgId, (tx) =>
      tx
        .select()
        .from(schema.licenseOrders)
        .where(and(eq(schema.licenseOrders.id, order.id))),
    );
    expect(visible).toEqual([]);
  });

  it('answers 503 until the bank account is configured', async () => {
    vi.stubEnv('SEPAY_BANK_ACCOUNT', '');
    const res = await place({ planId: plans.STARTER.id, termMonths: 3 }).expect(503);
    expect(res.body.message).toBe('License payments are not configured');
    expect(await rows()).toEqual([]);
  });
});
