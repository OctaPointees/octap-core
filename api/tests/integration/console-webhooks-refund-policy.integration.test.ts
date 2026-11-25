import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Test } from 'supertest';
import { WebhooksRepository } from '#infra/db/repositories/webhooks.repository.js';
import { createTestApp } from './support/app.js';
import { deliveriesWithEvents, resetDb, schema, seedCredential, seedDelivery, seedOrganization } from './support/db.js';

const ACTORS = ['owner', 'developer', 'stranger', 'inactive', 'outsider'] as const;
type Actor = (typeof ACTORS)[number];

const policy = {
  allowUnused: true,
  allowExpired: true,
  allowRedeemed: false,
  restockUnused: true,
  refundWindowDays: 30,
  reason: 'Customer service policy',
};

describe('console webhooks and refund policy: Owner only, from a Google session', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: Record<Actor, string>;
  let orgId: string;
  let otherOrgId: string;
  let reader: { authorization: string };
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
  const hooks = (path: string, org = orgId) => `/v1/console/organizations/${org}/webhooks${path}`;
  const refunds = (path = '', org = orgId) => `/v1/console/organizations/${org}/refund-policy${path}`;

  /** A registered endpoint with one dead-lettered delivery, the state every route can act on. */
  const seedWebhooks = async (org = orgId, actor: Actor = 'owner') => {
    const endpoint = (
      await ctx
        .http()
        .post(hooks('/endpoints', org))
        .set(as(actor))
        .send({ url: 'https://merchant.example/hooks', description: 'pos' })
        .expect(201)
    ).body as { id: string; secret: string };
    const repo = ctx.app.get(WebhooksRepository);
    const delivery = await seedDelivery(ctx.db, {
      organizationId: org,
      endpointId: endpoint.id,
      type: 'credits.earned',
      payload: { purchaseAmount: 100 },
    });
    await repo.markDeadLetter(delivery.id, 503, 'HTTP 503');
    return { endpoint, deliveryId: delivery.id };
  };

  /** Every console route this ticket adds, in an order the Owner can run them all in. */
  const routes = (endpointId: string, deliveryId: string): Array<[string, (actor: Actor) => Test, number]> => [
    ['list endpoints', (a) => ctx.http().get(hooks('/endpoints')).set(as(a)), 200],
    [
      'register an endpoint',
      (a) => ctx.http().post(hooks('/endpoints')).set(as(a)).send({ url: 'https://merchant.example/other' }),
      201,
    ],
    [
      'disable an endpoint',
      (a) =>
        ctx
          .http()
          .post(hooks(`/endpoints/${endpointId}/disable`))
          .set(as(a)),
      201,
    ],
    [
      'enable an endpoint',
      (a) =>
        ctx
          .http()
          .post(hooks(`/endpoints/${endpointId}/enable`))
          .set(as(a)),
      201,
    ],
    [
      'rotate a secret',
      (a) =>
        ctx
          .http()
          .post(hooks(`/endpoints/${endpointId}/rotate-secret`))
          .set(as(a)),
      201,
    ],
    ['list deliveries', (a) => ctx.http().get(hooks('/deliveries')).set(as(a)), 200],
    [
      'replay a delivery',
      (a) =>
        ctx
          .http()
          .post(hooks(`/deliveries/${deliveryId}/replay`))
          .set(as(a)),
      201,
    ],
    ['read the refund policy', (a) => ctx.http().get(refunds()).set(as(a)), 200],
    ['read its history', (a) => ctx.http().get(refunds('/history')).set(as(a)), 200],
    ['publish a refund policy', (a) => ctx.http().put(refunds()).set(as(a)).send(policy), 200],
  ];

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
    await ctx.db.insert(schema.organizationMemberships).values([
      { organizationId: orgId, systemUserId: ids.owner, role: 'OWNER' },
      { organizationId: orgId, systemUserId: ids.developer, role: 'BUSINESS_DEVELOPER' },
      { organizationId: orgId, systemUserId: ids.stranger, role: 'STAFF' },
      { organizationId: orgId, systemUserId: ids.inactive, role: 'OWNER', status: 'INACTIVE' },
      { organizationId: otherOrgId, systemUserId: ids.outsider, role: 'OWNER' },
    ]);
    reader = { authorization: `Bearer ${(await seedCredential(ctx.db, orgId, { scopes: ['read'] })).rawKey}` };
  });

  it('refuses everyone but the active Owner, a Business Developer included, and changes nothing when it does', async () => {
    const { endpoint, deliveryId } = await seedWebhooks();
    for (const actor of ['developer', 'stranger', 'inactive', 'outsider'] as const) {
      for (const [name, send] of routes(endpoint.id, deliveryId)) {
        const refused = await send(actor);
        expect([name, actor, refused.status]).toEqual([name, actor, 403]);
      }
    }
    // Nothing a refused caller sent took effect.
    const [stored] = await ctx.db.select().from(schema.webhookEndpoints);
    expect(await ctx.db.select().from(schema.webhookEndpoints)).toHaveLength(1);
    expect(stored).toMatchObject({ status: 'ACTIVE', secret: endpoint.secret });
    expect((await deliveriesWithEvents(ctx.db))[0].status).toBe('DEAD_LETTER');
    expect(await ctx.db.select().from(schema.voucherRefundPolicies)).toEqual([]);
    await ctx.http().get(refunds()).expect(401);
  });

  it('lets the Owner do everything, and refuses the Owner of a suspended organization', async () => {
    const { endpoint, deliveryId } = await seedWebhooks();
    for (const [name, send, status] of routes(endpoint.id, deliveryId)) {
      const response = await send('owner');
      expect([name, response.status]).toEqual([name, status]);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    await ctx.db.update(schema.organizations).set({ status: 'SUSPENDED' }).where(eq(schema.organizations.id, orgId));
    for (const [name, send] of routes(endpoint.id, deliveryId)) {
      expect([name, (await send('owner')).status]).toEqual([name, 403]);
    }
  });

  it('manages endpoints and deliveries, showing a secret only when it is issued', async () => {
    const { endpoint, deliveryId } = await seedWebhooks();
    expect(endpoint.secret).toMatch(/^whsec_/);
    const [listed] = (await ctx.http().get(hooks('/endpoints')).set(as('owner')).expect(200)).body;
    expect(listed).toMatchObject({ id: endpoint.id, url: 'https://merchant.example/hooks', status: 'ACTIVE' });
    expect(listed).not.toHaveProperty('secret');

    const disabled = await ctx
      .http()
      .post(hooks(`/endpoints/${endpoint.id}/disable`))
      .set(as('owner'))
      .expect(201);
    expect(disabled.body.status).toBe('DISABLED');
    expect(disabled.body).not.toHaveProperty('secret');
    expect((await ctx.http().get('/v1/webhooks/endpoints').set(reader).expect(200)).body[0].status).toBe('DISABLED');
    await ctx
      .http()
      .post(hooks(`/endpoints/${endpoint.id}/enable`))
      .set(as('owner'))
      .expect(201);
    const rotated = await ctx
      .http()
      .post(hooks(`/endpoints/${endpoint.id}/rotate-secret`))
      .set(as('owner'))
      .expect(201);
    expect(rotated.body.secret).toMatch(/^whsec_/);
    expect(rotated.body.secret).not.toBe(endpoint.secret);

    const replayed = await ctx
      .http()
      .post(hooks(`/deliveries/${deliveryId}/replay`))
      .set(as('owner'))
      .expect(201);
    expect(replayed.body).toMatchObject({ id: deliveryId, status: 'PENDING', attemptCount: 0 });
    // Only a DEAD_LETTER delivery replays.
    await ctx
      .http()
      .post(hooks(`/deliveries/${deliveryId}/replay`))
      .set(as('owner'))
      .expect(400);

    for (const body of [{}, { url: 'ftp://nope' }, { url: 'https://x', description: 7 }, []]) {
      await ctx.http().post(hooks('/endpoints')).set(as('owner')).send(body).expect(400);
    }
    await ctx.http().post(hooks('/endpoints/not-a-uuid/disable')).set(as('owner')).expect(400);
  });

  it('keeps each organization’s endpoints and deliveries to itself', async () => {
    const mine = await seedWebhooks();
    const theirs = await seedWebhooks(otherOrgId, 'outsider');
    // Another organization's endpoint or delivery, named under the Owner's own organization: not found.
    for (const action of ['disable', 'enable', 'rotate-secret']) {
      await ctx
        .http()
        .post(hooks(`/endpoints/${theirs.endpoint.id}/${action}`))
        .set(as('owner'))
        .expect(404);
    }
    await ctx
      .http()
      .post(hooks(`/deliveries/${theirs.deliveryId}/replay`))
      .set(as('owner'))
      .expect(404);
    // Named under their organization: the Owner is not a member there.
    await ctx
      .http()
      .post(hooks(`/endpoints/${theirs.endpoint.id}/disable`, otherOrgId))
      .set(as('owner'))
      .expect(403);

    const endpointIds = (await ctx.http().get(hooks('/endpoints')).set(as('owner')).expect(200)).body.map(
      (e: { id: string }) => e.id,
    );
    expect(endpointIds).toEqual([mine.endpoint.id]);
    const deliveryIds = (await ctx.http().get(hooks('/deliveries')).set(as('owner')).expect(200)).body.map(
      (d: { id: string }) => d.id,
    );
    expect(deliveryIds).toEqual([mine.deliveryId]);
    const [theirEndpoint] = await ctx.db
      .select()
      .from(schema.webhookEndpoints)
      .where(eq(schema.webhookEndpoints.id, theirs.endpoint.id));
    expect(theirEndpoint).toMatchObject({ status: 'ACTIVE', secret: theirs.endpoint.secret });
  });

  it('records the publishing Owner on each refund policy version, one version at a time', async () => {
    const first = await ctx.http().put(refunds()).set(as('owner')).send(policy).expect(200);
    expect(first.body).toMatchObject({
      version: 1,
      allowExpired: true,
      refundWindowDays: 30,
      reason: policy.reason,
      createdByUserId: ids.owner,
      createdByCredentialId: null,
    });
    const simultaneous = await Promise.all(
      ['Version A', 'Version B'].map((reason) =>
        ctx
          .http()
          .put(refunds())
          .set(as('owner'))
          .send({ ...policy, reason }),
      ),
    );
    expect(simultaneous.map((r) => r.status)).toEqual([200, 200]);
    expect(simultaneous.map((r) => r.body.version).sort()).toEqual([2, 3]);

    const history = (await ctx.http().get(refunds('/history')).set(as('owner')).expect(200)).body;
    expect(history.map((r: { version: number; createdByUserId: string }) => [r.version, r.createdByUserId])).toEqual([
      [3, ids.owner],
      [2, ids.owner],
      [1, ids.owner],
    ]);
    expect(
      (await ctx.http().get(refunds('/history?limit=1&beforeVersion=3')).set(as('owner')).expect(200)).body,
    ).toEqual([history[1]]);
    await ctx.http().get(refunds('/history?limit=0')).set(as('owner')).expect(400);
    // The console publishes, a read key sees the result; another organization keeps its own policy.
    expect((await ctx.http().get('/v1/rewards/refund-policy').set(reader).expect(200)).body).toEqual(history[0]);
    expect((await ctx.http().get(refunds('', otherOrgId)).set(as('outsider')).expect(200)).body.version).toBe(0);

    for (const body of [
      { ...policy, reason: '' },
      { ...policy, refundWindowDays: -1 },
      { ...policy, allowRedeemed: 'yes' },
      { ...policy, createdByUserId: ids.developer },
    ]) {
      await ctx.http().put(refunds()).set(as('owner')).send(body).expect(400);
    }
    expect((await ctx.http().get(refunds()).set(as('owner')).expect(200)).body.version).toBe(3);
  });
});
