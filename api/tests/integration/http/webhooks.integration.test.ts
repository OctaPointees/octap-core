import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { UnauthorizedException } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from '@octap/sdk';
import { WebhookDeliveryProcessor } from '#domain/webhooks/webhook-delivery.processor.js';
import { WebhooksRepository } from '#infra/db/repositories/webhooks.repository.js';
import { createTestApp } from '../support/app.js';
import {
  resetDb,
  schema,
  seedCredential,
  seedMember,
  seedOrganization,
  setOwnership,
  seedProgram,
} from '../support/db.js';

let ctx: Awaited<ReturnType<typeof createTestApp>>;
let orgId: string;
let memberId: string;
let auth: { authorization: string };
/** The organization's Owner, signed in to the console: endpoints are registered and changed there. */
const owner = { authorization: 'Bearer owner' };
const hooks = (path: string) => `/v1/console/organizations/${orgId}/webhooks${path}`;
const google = {
  verify: async (token: string) => {
    if (token !== 'owner') throw new UnauthorizedException();
    return {
      subject: token,
      email: `${token}@example.com`,
      fullName: token,
      avatarUrl: null,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
  },
};

/** A real merchant receiver on localhost: records what it got, answers with `status`. */
const receiver = {
  server: undefined as Server | undefined,
  url: '',
  status: 200,
  received: [] as Array<{ headers: IncomingMessage['headers']; body: string }>,
};

beforeAll(async () => {
  ctx = await createTestApp(undefined, google);
  receiver.server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      receiver.received.push({ headers: req.headers, body });
      res.statusCode = receiver.status;
      res.end();
    });
  });
  await new Promise<void>((resolve) => receiver.server!.listen(0, '127.0.0.1', resolve));
  receiver.url = `http://127.0.0.1:${(receiver.server.address() as AddressInfo).port}/hooks`;
});

beforeEach(async () => {
  await resetDb(ctx.db);
  receiver.received = [];
  receiver.status = 200;
  orgId = (await seedOrganization(ctx.db)).id;
  await seedProgram(ctx.db, orgId);
  memberId = (await seedMember(ctx.db, orgId)).memberId;
  auth = { authorization: `Bearer ${(await seedCredential(ctx.db, orgId)).rawKey}` };
  await setOwnership(ctx.db, memberId, { confirmedBalance: 100 });
  const ownerId = (await ctx.http().post('/v1/console/auth/google').send({ idToken: 'owner' }).expect(201)).body.user
    .id;
  await ctx.db
    .insert(schema.organizationMemberships)
    .values({ organizationId: orgId, systemUserId: ownerId, role: 'OWNER' });
});

afterAll(async () => {
  await ctx.close();
  await new Promise((resolve) => receiver.server?.close(resolve));
});

async function deliverDue() {
  const repo = ctx.app.get(WebhooksRepository);
  const processor = new WebhookDeliveryProcessor(repo);
  for (const delivery of await repo.claimDueDeliveries(10)) {
    await processor.process(delivery);
  }
}

describe('webhooks over HTTP, delivered to a real receiver', () => {
  it('a business event is signed with the endpoint secret and verifies with the Node SDK', async () => {
    const endpoint = await ctx
      .http()
      .post(hooks('/endpoints'))
      .set(owner)
      .send({ url: receiver.url, description: 'pos' })
      .expect(201);
    expect(endpoint.body.secret).toMatch(/^whsec_/);
    expect(endpoint.headers['cache-control']).toBe('no-store');
    // Listing never shows the secret, from the console or with a read key.
    expect((await ctx.http().get(hooks('/endpoints')).set(owner).expect(200)).body[0]).not.toHaveProperty('secret');
    expect((await ctx.http().get('/v1/webhooks/endpoints').set(auth).expect(200)).body[0]).not.toHaveProperty('secret');

    await ctx
      .http()
      .post('/v1/credits/earn')
      .set(auth)
      .send({ organizationEndUserId: memberId, purchaseAmount: 100, idempotencyKey: 'r-1' })
      .expect(201);
    await deliverDue();

    expect(receiver.received).toHaveLength(1);
    const [{ headers, body }] = receiver.received;
    expect(verifyWebhookSignature(body, headers['x-octap-signature'] as string, endpoint.body.secret)).toBe(true);
    expect(headers['x-octap-event-type']).toBe('credits.earned');
    expect(JSON.parse(body)).toMatchObject({
      type: 'credits.earned',
      data: { purchaseAmount: 100, estimatedPoints: 1, newBalance: 100, organizationEndUserId: memberId },
    });

    const [delivery] = (await ctx.http().get('/v1/webhooks/deliveries').set(auth).expect(200)).body;
    expect((await ctx.http().get(hooks('/deliveries')).set(owner).expect(200)).body).toEqual([delivery]);
    // The body's id and the header are the event's, not the delivery's (OCT-325).
    expect(JSON.parse(body).id).toBe(headers['x-octap-event-id']);
    expect(delivery).toMatchObject({
      eventId: headers['x-octap-event-id'],
      eventType: 'credits.earned',
      status: 'DELIVERED',
      lastResponseStatus: 200,
      attemptCount: 1,
    });
  });

  it('a failing receiver gets a retry scheduled; a dead-lettered delivery can be replayed under the same id', async () => {
    await ctx.http().post(hooks('/endpoints')).set(owner).send({ url: receiver.url }).expect(201);
    receiver.status = 503;
    await ctx
      .http()
      .post('/v1/credits/earn')
      .set(auth)
      .send({ organizationEndUserId: memberId, purchaseAmount: 100, idempotencyKey: 'r' })
      .expect(201);
    await deliverDue();

    const [pending] = (await ctx.http().get('/v1/webhooks/deliveries').set(auth).expect(200)).body;
    expect(pending).toMatchObject({ status: 'PENDING', lastResponseStatus: 503, lastError: 'HTTP 503' });
    await ctx
      .http()
      .post(hooks(`/deliveries/${pending.id}/replay`))
      .set(owner)
      .expect(400);

    await ctx.app.get(WebhooksRepository).markDeadLetter(pending.id, 503, 'HTTP 503');
    const replayed = await ctx
      .http()
      .post(hooks(`/deliveries/${pending.id}/replay`))
      .set(owner)
      .expect(201);
    expect(replayed.body).toMatchObject({
      id: pending.id,
      eventId: pending.eventId,
      status: 'PENDING',
      attemptCount: 0,
    });

    receiver.status = 200;
    await deliverDue();
    expect(receiver.received.at(-1)?.headers['x-octap-event-id']).toBe(pending.eventId);
  });

  it('disable stops deliveries, enable resumes them, rotate-secret returns a new secret once', async () => {
    const endpoint = (await ctx.http().post(hooks('/endpoints')).set(owner).send({ url: receiver.url }).expect(201))
      .body;

    await ctx
      .http()
      .post(hooks(`/endpoints/${endpoint.id}/disable`))
      .set(owner)
      .expect(201);
    await ctx
      .http()
      .post('/v1/credits/earn')
      .set(auth)
      .send({ organizationEndUserId: memberId, purchaseAmount: 100, idempotencyKey: 'r-1' })
      .expect(201);
    await deliverDue();
    expect(receiver.received).toEqual([]);

    await ctx
      .http()
      .post(hooks(`/endpoints/${endpoint.id}/enable`))
      .set(owner)
      .expect(201);
    const rotated = (
      await ctx
        .http()
        .post(hooks(`/endpoints/${endpoint.id}/rotate-secret`))
        .set(owner)
        .expect(201)
    ).body;
    expect(rotated.secret).not.toBe(endpoint.secret);

    await ctx
      .http()
      .post('/v1/credits/earn')
      .set(auth)
      .send({ organizationEndUserId: memberId, purchaseAmount: 100, idempotencyKey: 'r-2' })
      .expect(201);
    await deliverDue();
    const [{ headers, body }] = receiver.received;
    expect(verifyWebhookSignature(body, headers['x-octap-signature'] as string, rotated.secret)).toBe(true);
  });

  it('validates the URL, and no API key registers or changes an endpoint any more', async () => {
    const endpoint = (await ctx.http().post(hooks('/endpoints')).set(owner).send({ url: receiver.url }).expect(201))
      .body;
    await ctx.http().post(hooks('/endpoints')).set(owner).send({}).expect(400);
    await ctx.http().post(hooks('/endpoints')).set(owner).send({ url: 'ftp://nope' }).expect(400);

    // A key that still carries the retired `admin` scope gets no further than a write key.
    const legacy = {
      authorization: `Bearer ${(await seedCredential(ctx.db, orgId, { scopes: ['read', 'write', 'admin'] })).rawKey}`,
    };
    for (const key of [auth, legacy]) {
      await ctx.http().post('/v1/webhooks/endpoints').set(key).send({ url: receiver.url }).expect(404);
      for (const action of ['disable', 'enable', 'rotate-secret'])
        await ctx.http().post(`/v1/webhooks/endpoints/${endpoint.id}/${action}`).set(key).expect(404);
      await ctx.http().post(`/v1/webhooks/deliveries/${endpoint.id}/replay`).set(key).expect(404);
    }
    expect((await ctx.http().get('/v1/webhooks/endpoints').set(legacy).expect(200)).body).toHaveLength(1);
  });
});
