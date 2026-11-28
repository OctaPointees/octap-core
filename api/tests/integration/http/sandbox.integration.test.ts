import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { createTestApp } from '../support/app.js';
import {
  getOwnership,
  resetDb,
  schema,
  seedCredential,
  seedMember,
  seedOrganization,
  seedProgram,
} from '../support/db.js';
import { POS_BENEFIT } from '../../helpers/fixtures.js';

const ACTORS = ['owner', 'developer'] as const;
type Actor = (typeof ACTORS)[number];

describe('sandbox mode: a sandbox key never touches real points, the chain or webhooks (OCT-297)', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let orgId: string;
  let memberId: string;
  let sandbox: { authorization: string };
  let live: { authorization: string };
  let ids: Record<Actor, string>;
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
  const as = (actor: Actor) => ({ Authorization: `Bearer ${actor}` });
  const earn = (auth: { authorization: string }, body: Record<string, unknown> = {}) =>
    ctx
      .http()
      .post('/v1/credits/earn')
      .set(auth)
      .send({ organizationEndUserId: memberId, purchaseAmount: 100_000, idempotencyKey: 'earn-1', ...body });
  const reserve = (body: Record<string, unknown> = {}) =>
    ctx
      .http()
      .post('/v1/credits/redeem/reserve')
      .set(sandbox)
      .send({
        organizationEndUserId: memberId,
        pointsAmount: 300,
        idempotencyKey: 'redeem-1',
        ...POS_BENEFIT,
        ...body,
      });
  const rows = {
    liveTransactions: () => ctx.db.select().from(schema.loyaltyTransactions),
    operations: () => ctx.db.select().from(schema.operations),
    events: () => ctx.db.select().from(schema.organizationEvents),
    deliveries: () => ctx.db.select().from(schema.webhookDeliveries),
  };

  beforeAll(async () => {
    ctx = await createTestApp(undefined, google);
  });
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await resetDb(ctx.db);
    orgId = (await seedOrganization(ctx.db)).id;
    await seedProgram(ctx.db, orgId);
    memberId = (await seedMember(ctx.db, orgId)).memberId;
    sandbox = {
      authorization: `Bearer ${(await seedCredential(ctx.db, orgId, { environment: 'SANDBOX' })).rawKey}`,
    };
    live = { authorization: `Bearer ${(await seedCredential(ctx.db, orgId)).rawKey}` };
    ids = {} as Record<Actor, string>;
    for (const actor of ACTORS) {
      ids[actor] = (await ctx.http().post('/v1/console/auth/google').send({ idToken: actor }).expect(201)).body.user.id;
    }
    await ctx.db.insert(schema.organizationMemberships).values([
      { organizationId: orgId, systemUserId: ids.owner, role: 'OWNER' },
      { organizationId: orgId, systemUserId: ids.developer, role: 'BUSINESS_DEVELOPER' },
    ]);
    // An active endpoint: anything that recorded an event would queue a delivery to it.
    await ctx.db
      .insert(schema.webhookEndpoints)
      .values({ organizationId: orgId, url: 'https://hooks.example.com', secret: 's' });
  });

  it('earns on the sandbox ledger: confirmed at once, real balance, chain and outbox untouched', async () => {
    const res = await earn(sandbox).expect(201);
    expect(res.body).toMatchObject({
      isSandbox: true,
      status: 'CONFIRMED',
      purchaseAmount: 100_000,
      estimatedPoints: null,
      pointsEarned: 1000,
      newBalance: 1000,
    });

    expect(await getOwnership(ctx.db, memberId)).toBeFalsy();
    expect(await rows.liveTransactions()).toHaveLength(0);
    expect(await rows.operations()).toHaveLength(0);
    expect(await rows.events()).toHaveLength(0);
    expect(await rows.deliveries()).toHaveLength(0);

    const balance = await ctx.http().get(`/v1/credits/members/${memberId}/balance`).set(sandbox).expect(200);
    expect(balance.body).toMatchObject({ isSandbox: true, confirmedBalance: 1000, lifetimeEarned: 1000 });
    const liveBalance = await ctx.http().get(`/v1/credits/members/${memberId}/balance`).set(live).expect(200);
    expect(liveBalance.body.confirmedBalance).toBe(0);
    expect(liveBalance.body).not.toHaveProperty('isSandbox');
  });

  it('is idempotent like live: a replay returns the first earn, a changed payload is a 409', async () => {
    const first = (await earn(sandbox).expect(201)).body;
    const again = (await earn(sandbox).expect(201)).body;
    expect(again).toEqual(first);
    await earn(sandbox, { purchaseAmount: 200_000 }).expect(409);
    // A sandbox key and a live key never share an idempotency key space.
    expect((await rows.liveTransactions()).length).toBe(0);
  });

  it('validates like live: too small a purchase and an unknown member are refused', async () => {
    await earn(sandbox, { purchaseAmount: 50 }).expect(400);
    await earn(sandbox, { organizationEndUserId: randomUUID() }).expect(404);
  });

  it('reserves and finalizes a redemption without Enoki or the chain', async () => {
    await earn(sandbox).expect(201);
    const reserved = (await reserve().expect(201)).body;
    expect(reserved).toMatchObject({ isSandbox: true, status: 'PENDING', digest: expect.stringMatching(/^sandbox_/) });
    expect(reserved.transactionBytes).toEqual(expect.any(String));
    expect((await ctx.http().get(`/v1/credits/members/${memberId}/balance`).set(sandbox)).body).toMatchObject({
      confirmedBalance: 1000,
      pendingRedemption: 300,
      stale: true,
    });
    expect((await reserve().expect(201)).body.digest).toBe(reserved.digest);

    const finalized = await ctx
      .http()
      .post('/v1/credits/redeem/finalize')
      .send({ digest: reserved.digest, signature: 'anything' })
      .expect(201);
    expect(finalized.body).toMatchObject({
      isSandbox: true,
      status: 'CONFIRMED',
      pointsRedeemed: 300,
      newBalance: 700,
      blockchainDigest: reserved.digest,
    });
    // Finalizing again answers the same way.
    await ctx.http().post('/v1/credits/redeem/finalize').send({ digest: reserved.digest, signature: 'x' }).expect(201);

    expect(ctx.adapters.enoki.createSponsoredTransaction).not.toHaveBeenCalled();
    expect(ctx.adapters.enoki.executeSponsoredTransaction).not.toHaveBeenCalled();
    expect(ctx.adapters.suiBuilder.waitForTransaction).not.toHaveBeenCalled();
    expect(await rows.events()).toHaveLength(0);
    expect(await rows.operations()).toHaveLength(0);

    const history = (await ctx.http().get(`/v1/credits/members/${memberId}/transactions`).set(sandbox).expect(200))
      .body;
    expect(history.items.map((item: { transactionType: string }) => item.transactionType)).toEqual(['REDEEM', 'EARN']);
    expect(history.items.every((item: { isSandbox: boolean }) => item.isSandbox)).toBe(true);
    const liveHistory = (await ctx.http().get(`/v1/credits/members/${memberId}/transactions`).set(live).expect(200))
      .body;
    expect(liveHistory.items).toEqual([]);
  });

  it('refuses a redemption the sandbox balance cannot cover', async () => {
    await earn(sandbox).expect(201);
    await reserve({ pointsAmount: 5000 }).expect(400);
  });

  it('refuses a non-integer amount with 400, like live', async () => {
    await earn(sandbox).expect(201);
    await reserve({ pointsAmount: 1.5 }).expect(400);
  });

  it('releases a hold that expired unsigned, for good, and a retry under its key answers FAILED', async () => {
    await earn(sandbox).expect(201);
    const reserved = (await reserve().expect(201)).body;
    const expired = new Date(Date.now() - 31 * 60 * 1000);
    await ctx.db
      .update(schema.sandboxLoyaltyTransactions)
      .set({ createdAt: expired })
      .where(eq(schema.sandboxLoyaltyTransactions.id, reserved.transactionId));

    // History alone (no balance read first) already shows it released.
    const history = (await ctx.http().get(`/v1/credits/members/${memberId}/transactions`).set(sandbox).expect(200))
      .body;
    // Backdating the hold put it behind the earn: find it by id, not by position.
    expect(history.items.find((item: { id: string }) => item.id === reserved.transactionId)).toMatchObject({
      transactionType: 'REDEEM',
      status: 'FAILED',
    });

    const finalize = () =>
      ctx.http().post('/v1/credits/redeem/finalize').send({ digest: reserved.digest, signature: 'late' }).expect(409);
    await finalize();
    await finalize();
    const balance = (await ctx.http().get(`/v1/credits/members/${memberId}/balance`).set(sandbox).expect(200)).body;
    expect(balance).toMatchObject({ confirmedBalance: 1000, pendingRedemption: 0 });

    const retried = (await reserve().expect(201)).body;
    expect(retried).toMatchObject({ transactionId: reserved.transactionId, status: 'FAILED', digest: null });
  });

  it('finalize releases an expired hold it finds, and the release sticks', async () => {
    await earn(sandbox).expect(201);
    const reserved = (await reserve().expect(201)).body;
    await ctx.db
      .update(schema.sandboxLoyaltyTransactions)
      .set({ createdAt: new Date(Date.now() - 31 * 60 * 1000) })
      .where(eq(schema.sandboxLoyaltyTransactions.id, reserved.transactionId));
    await ctx.http().post('/v1/credits/redeem/finalize').send({ digest: reserved.digest, signature: 's' }).expect(409);
    const [hold] = await ctx.db
      .select()
      .from(schema.sandboxLoyaltyTransactions)
      .where(eq(schema.sandboxLoyaltyTransactions.id, reserved.transactionId));
    expect(hold.status).toBe('FAILED');
    const [balance] = await ctx.db.select().from(schema.sandboxCreditBalances);
    expect(balance).toMatchObject({ confirmedBalance: 1000, pendingRedemption: 0 });
  });

  it('verifies a customer with a sandbox key: the first step of the POS flow', async () => {
    const verified = await ctx
      .http()
      .post('/v1/identity/verify')
      .set(sandbox)
      .send({ idToken: 'google-jwt' })
      .expect(200);
    expect(verified.body).toMatchObject({ suiAddress: '0xzklogin' });
  });

  it('is refused (403 SANDBOX_NOT_SUPPORTED) on every write route that does not handle sandbox', async () => {
    const reverse = await ctx
      .http()
      .post(`/v1/credits/transactions/${randomUUID()}/reverse`)
      .set(sandbox)
      .send({ idempotencyKey: 'r', reason: 'x' })
      .expect(403);
    expect(reverse.body.code).toBe('SANDBOX_NOT_SUPPORTED');
    const voucher = await ctx.http().post('/v1/rewards/vouchers').set(sandbox).send({}).expect(403);
    expect(voucher.body.code).toBe('SANDBOX_NOT_SUPPORTED');
    // Reads still work.
    await ctx.http().get('/v1/rewards/vouchers').set(sandbox).expect(200);
  });

  it('issues a sandbox key from the console, recognisable by its prefix, also to a Business Developer', async () => {
    const res = await ctx
      .http()
      .post(`/v1/console/organizations/${orgId}/api-credentials`)
      .set(as('developer'))
      .send({ name: 'sandbox', scope: 'write', environment: 'SANDBOX' })
      .expect(201);
    expect(res.body).toMatchObject({ environment: 'SANDBOX', scopes: ['read', 'write'] });
    expect(res.body.rawKey).toMatch(/^octap_test_/);
    await earn({ authorization: `Bearer ${res.body.rawKey}` }, { idempotencyKey: 'console-key' }).expect(201);
    await ctx
      .http()
      .post(`/v1/console/organizations/${orgId}/api-credentials`)
      .set(as('developer'))
      .send({ name: 'live', scope: 'write' })
      .expect(403);
  });

  it('sends a webhook test event to one endpoint only, from an Owner or a Business Developer', async () => {
    const [target] = await ctx.db.select().from(schema.webhookEndpoints);
    const test = (actor: Actor, endpointId = target.id) =>
      ctx.http().post(`/v1/console/organizations/${orgId}/webhooks/endpoints/${endpointId}/test`).set(as(actor));
    const [other] = await ctx.db
      .insert(schema.webhookEndpoints)
      .values({ organizationId: orgId, url: 'https://other.example.com', secret: 's2' })
      .returning();

    const res = await test('owner').expect(201);
    expect(res.body).toMatchObject({ endpointId: target.id, eventType: 'webhook.test', status: 'PENDING' });
    const deliveries = await rows.deliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ endpointId: target.id, eventId: res.body.eventId });
    const [event] = await ctx.db
      .select()
      .from(schema.organizationEvents)
      .where(eq(schema.organizationEvents.id, res.body.eventId));
    expect(event).toMatchObject({ type: 'webhook.test', payload: expect.objectContaining({ endpointId: target.id }) });
    expect(deliveries.some((delivery) => delivery.endpointId === other.id)).toBe(false);

    await test('developer').expect(201);
    expect(await rows.deliveries()).toHaveLength(2);
    await test('owner', randomUUID()).expect(404);
    await ctx.db
      .update(schema.webhookEndpoints)
      .set({ status: 'DISABLED' })
      .where(eq(schema.webhookEndpoints.id, other.id));
    await test('owner', other.id).expect(409);
  });
});
