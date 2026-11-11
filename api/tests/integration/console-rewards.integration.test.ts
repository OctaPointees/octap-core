import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { createTestApp } from './support/app.js';
import {
  resetDb,
  schema,
  seedCredential,
  seedMember,
  seedOrganization,
  seedProgram,
  setOwnership,
} from './support/db.js';
import { RewardsRepository } from '#infra/db/repositories/rewards.repository.js';

const ACTORS = ['owner', 'developer', 'stranger', 'inactive', 'outsider'] as const;
type Actor = (typeof ACTORS)[number];

const reward = { code: 'coffee', title: 'Free coffee', discountType: 'FREE_ITEM', pointsCost: 100, totalSupply: 10 };

describe('console rewards: list, create, edit, pause and activate from a Google session', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: Record<Actor, string>;
  let orgId: string;
  let otherOrgId: string;
  let memberId: string;
  let apiKey: { authorization: string };
  const google = {
    verify: async (token: string) => {
      if (!(ACTORS as readonly string[]).includes(token)) throw new UnauthorizedException();
      return {
        subject: token,
        email: `${token}@example.com`,
        fullName: token,
        avatarUrl: null,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
    },
  };
  const path = (org = orgId) => `/v1/console/organizations/${org}/vouchers`;
  const as = (actor: Actor) => ({ Authorization: `Bearer ${actor}` });
  const create = (actor: Actor, body: Record<string, unknown> = reward, org = orgId) =>
    ctx.http().post(path(org)).set(as(actor)).send(body);
  const patch = (actor: Actor, id: string, body: Record<string, unknown>) =>
    ctx.http().patch(`${path()}/${id}`).set(as(actor)).send(body);
  /** What the worker does once the chain holds the terms. */
  const publish = (id: string) => ctx.app.get(RewardsRepository).markVoucherPublished(id, `0xterms-${id}`);
  const activate = async (id: string) => {
    await patch('owner', id, { status: 'ACTIVE' }).expect(200);
    await publish(id);
  };

  beforeAll(async () => {
    ctx = await createTestApp(undefined, google);
  });
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await resetDb(ctx.db);
    ids = {} as Record<Actor, string>;
    for (const actor of ACTORS) {
      ids[actor] = (await ctx.http().post('/v1/console/auth/google').send({ idToken: actor }).expect(201)).body.user.id;
    }
    orgId = (await seedOrganization(ctx.db)).id;
    otherOrgId = (await seedOrganization(ctx.db)).id;
    await seedProgram(ctx.db, orgId);
    await ctx.db.insert(schema.organizationMemberships).values([
      { organizationId: orgId, systemUserId: ids.owner, role: 'OWNER' },
      { organizationId: orgId, systemUserId: ids.developer, role: 'BUSINESS_DEVELOPER' },
      { organizationId: orgId, systemUserId: ids.stranger, role: 'STAFF' },
      { organizationId: orgId, systemUserId: ids.inactive, role: 'OWNER', status: 'INACTIVE' },
      { organizationId: otherOrgId, systemUserId: ids.outsider, role: 'OWNER' },
    ]);
    memberId = (await seedMember(ctx.db, orgId)).memberId;
    await setOwnership(ctx.db, memberId, { confirmedBalance: 100, suiCreditAccountId: '0xaccount' });
    apiKey = { authorization: `Bearer ${(await seedCredential(ctx.db, orgId, { scopes: ['read', 'write'] })).rawKey}` };
  });

  it('lets the Owner create a DRAFT, activate, pause and activate it again', async () => {
    const created = await create('owner').expect(201);
    expect(created.headers['cache-control']).toBe('no-store');
    // A DRAFT stays off the chain, so every field can still change.
    expect(created.body).toMatchObject({
      code: 'coffee',
      pointsCost: 100,
      totalSupply: 10,
      claimedCount: 0,
      status: 'DRAFT',
      publishStatus: 'NOT_PUBLISHED',
    });
    const id = created.body.id as string;
    expect((await patch('owner', id, { title: 'Free latte' }).expect(200)).body.title).toBe('Free latte');

    // Activating queues the terms for the chain; ACTIVE once the worker has published them.
    expect((await patch('owner', id, { status: 'ACTIVE' }).expect(200)).body).toMatchObject({
      status: 'DRAFT',
      publishStatus: 'PUBLISHING',
    });
    await publish(id);
    const detail = await ctx.http().get(`${path()}/${id}`).set(as('owner')).expect(200);
    expect(detail.headers['cache-control']).toBe('no-store');
    expect(detail.body).toMatchObject({ status: 'ACTIVE', publishStatus: 'PUBLISHED', suiTermsId: `0xterms-${id}` });

    expect((await patch('owner', id, { status: 'PAUSED' }).expect(200)).body.status).toBe('PAUSED');
    // Already on-chain: activating again takes effect at once.
    expect((await patch('owner', id, { status: 'ACTIVE' }).expect(200)).body.status).toBe('ACTIVE');
    // Supply can still change; the published promise cannot.
    expect((await patch('owner', id, { totalSupply: 20 }).expect(200)).body.totalSupply).toBe(20);
    expect((await patch('owner', id, { pointsCost: 50 }).expect(409)).body.message).toMatch(/cannot change after/);
  });

  it('requires pointsCost, allows 0, and reports validation errors and duplicates', async () => {
    const withoutCost: Record<string, unknown> = { ...reward };
    delete withoutCost.pointsCost;
    expect((await create('owner', withoutCost).expect(400)).body.message).toMatch(/pointsCost is required/);
    expect((await create('owner', { ...reward, code: 'free', pointsCost: 0 }).expect(201)).body.pointsCost).toBe(0);

    for (const [body, message] of [
      [{ ...reward, code: '' }, /code, title, and either discountType or terms are required/],
      [{ ...reward, pointsCost: -1 }, /pointsCost must be a nonnegative/],
      [{ ...reward, startsAt: '2026-11-20' }, /ISO date-time with a timezone/],
      [{ ...reward, claimedCount: 3 }, /unsupported fields/],
      [{ ...reward, status: 'ACTIVE' }, /created as DRAFT; activate it with PATCH/],
      [{ ...reward, status: 'PAUSED' }, /created as DRAFT/],
    ] as const) {
      expect((await create('owner', body).expect(400)).body.message).toMatch(message);
    }
    await create('owner').expect(201);
    expect((await create('owner').expect(409)).body.message).toMatch(/already exists/);
  });

  it('lets a Business Developer read the catalog, and only the Owner change it', async () => {
    const { id } = (await create('owner').expect(201)).body as { id: string };
    expect((await ctx.http().get(path()).set(as('developer')).expect(200)).body).toHaveLength(1);
    await ctx.http().get(`${path()}/${id}`).set(as('developer')).expect(200);

    await create('developer', { ...reward, code: 'bd' }).expect(403);
    await patch('developer', id, { status: 'ACTIVE' }).expect(403);
    for (const actor of ['stranger', 'inactive', 'outsider'] as const) {
      await ctx.http().get(path()).set(as(actor)).expect(403);
      await ctx.http().get(`${path()}/${id}`).set(as(actor)).expect(403);
      await create(actor, { ...reward, code: actor }).expect(403);
      await patch(actor, id, { title: 'stolen' }).expect(403);
    }
    await ctx.http().post(path()).send(reward).expect(401);
    await ctx.http().get(path()).expect(401);

    const rows = await ctx.db.select().from(schema.vouchers);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, status: 'DRAFT', title: 'Free coffee' });
  });

  it('changes nothing for an organization that is not ACTIVE', async () => {
    const { id } = (await create('owner').expect(201)).body as { id: string };
    await ctx.db.update(schema.organizations).set({ status: 'SUSPENDED' }).where(eq(schema.organizations.id, orgId));
    await create('owner', { ...reward, code: 'late' }).expect(403);
    await patch('owner', id, { status: 'ACTIVE' }).expect(403);
    await ctx.http().get(path()).set(as('owner')).expect(403);
    expect((await ctx.db.select().from(schema.vouchers)).map((v) => v.status)).toEqual(['DRAFT']);
  });

  it('answers 404 for another organization’s voucher, and 400 for a malformed id', async () => {
    const foreign = (await create('outsider', reward, otherOrgId).expect(201)).body as { id: string };
    await ctx.http().get(`${path()}/${foreign.id}`).set(as('owner')).expect(404);
    await patch('owner', foreign.id, { title: 'mine now' }).expect(404);
    expect((await ctx.http().get(path()).set(as('owner')).expect(200)).body).toEqual([]);
    await ctx.http().get(`${path()}/not-a-uuid`).set(as('owner')).expect(400);
    await ctx
      .http()
      .get(`${path('not-a-uuid')}`)
      .set(as('owner'))
      .expect(400);
  });

  it('puts an activated reward in this organization’s API-key catalog only', async () => {
    const { id } = (await create('owner').expect(201)).body as { id: string };
    await activate(id);
    const catalog = (await ctx.http().get('/v1/rewards/vouchers').set(apiKey).expect(200)).body as { id: string }[];
    expect(catalog).toEqual([expect.objectContaining({ id, status: 'ACTIVE' })]);

    const otherKey = { authorization: `Bearer ${(await seedCredential(ctx.db, otherOrgId)).rawKey}` };
    expect((await ctx.http().get('/v1/rewards/vouchers').set(otherKey).expect(200)).body).toEqual([]);
    await ctx.http().get(`/v1/rewards/vouchers/${id}`).set(otherKey).expect(404);
  });

  it('delivery scenario: an Owner’s 100-point reward, claimed for 100 points, used exactly once', async () => {
    const { id } = (await create('owner').expect(201)).body as { id: string };
    await activate(id);

    const claimed = await ctx
      .http()
      .post(`/v1/rewards/vouchers/${id}/claim`)
      .set(apiKey)
      .send({ organizationEndUserId: memberId, idempotencyKey: 'console-reward-claim' })
      .expect(201);
    expect(claimed.body).toMatchObject({ pointsCost: 100, status: 'RESERVED' });
    await ctx
      .http()
      .post('/v1/credits/redeem/finalize')
      .send({ digest: claimed.body.digest, signature: 'customer-signature' })
      .expect(201);
    const balance = await ctx.http().get(`/v1/credits/members/${memberId}/balance`).set(apiKey).expect(200);
    expect(balance.body).toMatchObject({ confirmedBalance: 0, pendingRedemption: 0 });
    expect((await ctx.http().get(`${path()}/${id}`).set(as('owner')).expect(200)).body.claimedCount).toBe(1);

    const use = (key: string) =>
      ctx
        .http()
        .post('/v1/rewards/vouchers/use')
        .set(apiKey)
        .send({ serialCode: claimed.body.serialCode, idempotencyKey: key });
    const prepared = await use('use-1').expect(201);
    const redeemed = await ctx
      .http()
      .post('/v1/rewards/vouchers/use/finalize')
      .send({ digest: prepared.body.digest, signature: 'customer-signature' })
      .expect(201);
    expect(redeemed.body).toMatchObject({ status: 'REDEEMED', voucherTitle: 'Free coffee' });
    await use('use-2').expect(400);
  });

  it('does not deadlock with a claim: the Owner check holds the organization FOR SHARE', async () => {
    const { id } = (await create('owner').expect(201)).body as { id: string };
    await activate(id);

    // Takes a claim's locks in a claim's order, with the console PATCH arriving in between:
    // the voucher FOR UPDATE, then (once the PATCH waits on that voucher) the organization FOR SHARE.
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    let markLocked!: () => void;
    const voucherLocked = new Promise<void>((resolve) => (markLocked = resolve));
    const claimLike = ctx.db.transaction(async (tx) => {
      await tx.select().from(schema.vouchers).where(eq(schema.vouchers.id, id)).for('update');
      markLocked();
      await gate;
      await tx.select().from(schema.organizations).where(eq(schema.organizations.id, orgId)).for('share');
    });
    await voucherLocked;

    const edit = patch('owner', id, { totalSupply: 5 }).then((response) => response);
    let waiting = 0;
    for (let i = 0; i < 100 && waiting === 0; i += 1) {
      const [row] = await ctx.db.execute<{ waiting: number }>(
        sql`select count(*)::int as waiting from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'`,
      );
      waiting = row.waiting;
      if (waiting === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // The PATCH holds the organization and waits on the voucher.
    expect(waiting).toBe(1);

    // With the organization FOR UPDATE here, this would wait on the PATCH, which waits on it: a deadlock.
    openGate();
    await expect(claimLike).resolves.toBeUndefined();
    const response = await edit;
    expect(response.status).toBe(200);
    expect(response.body.totalSupply).toBe(5);
  });

  it('runs PATCH and a real claim on the same voucher at once without errors', async () => {
    const { id } = (await create('owner').expect(201)).body as { id: string };
    await activate(id);
    const [edited, claimed] = await Promise.all([
      patch('owner', id, { totalSupply: 4 }),
      ctx
        .http()
        .post(`/v1/rewards/vouchers/${id}/claim`)
        .set(apiKey)
        .send({ organizationEndUserId: memberId, idempotencyKey: 'parallel-claim' }),
    ]);
    expect(edited.status).toBe(200);
    expect(claimed.status).toBe(201);
    expect((await ctx.http().get(`${path()}/${id}`).set(as('owner')).expect(200)).body).toMatchObject({
      totalSupply: 4,
      claimedCount: 1,
    });
  });
});
