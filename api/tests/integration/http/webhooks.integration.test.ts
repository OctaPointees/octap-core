import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from '@octap/sdk';
import { WebhookDeliveryProcessor } from '../../../src/domain/webhooks/webhook-delivery.processor.js';
import { WebhooksRepository } from '../../../src/infra/db/repositories/webhooks.repository.js';
import { createTestApp } from '../support/app.js';
import { resetDb, seedCredential, seedMember, seedOrganization, setOwnership } from '../support/db.js';

let ctx: Awaited<ReturnType<typeof createTestApp>>;
let orgId: string;
let memberId: string;
let auth: { authorization: string };

/** A real merchant receiver on localhost: records what it got, answers with `status`. */
const receiver = {
  server: undefined as Server | undefined,
  url: '',
  status: 200,
  received: [] as Array<{ headers: IncomingMessage['headers']; body: string }>,
};

beforeAll(async () => {
  ctx = await createTestApp();
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
  memberId = (await seedMember(ctx.db, orgId)).memberId;
  auth = { authorization: `Bearer ${(await seedCredential(ctx.db, orgId)).rawKey}` };
  await setOwnership(ctx.db, memberId, { confirmedBalance: 100 });
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
    const endpoint = await ctx.http().post('/v1/webhooks/endpoints').set(auth).send({ url: receiver.url, description: 'pos' }).expect(201);
    expect(endpoint.body.secret).toMatch(/^whsec_/);
    expect((await ctx.http().get('/v1/webhooks/endpoints').set(auth).expect(200)).body[0]).not.toHaveProperty('secret');

    await ctx.http().post('/v1/credits/redeem').set(auth).send({ organizationEndUserId: memberId, pointsAmount: 10, idempotencyKey: 'r-1' }).expect(201);
    await deliverDue();

    expect(receiver.received).toHaveLength(1);
    const [{ headers, body }] = receiver.received;
    expect(verifyWebhookSignature(body, headers['x-octap-signature'] as string, endpoint.body.secret)).toBe(true);
    expect(headers['x-octap-event-type']).toBe('credits.redeemed');
    expect(JSON.parse(body)).toMatchObject({ type: 'credits.redeemed', data: { pointsAmount: 10, newBalance: 90, organizationEndUserId: memberId } });

    const [delivery] = (await ctx.http().get('/v1/webhooks/deliveries').set(auth).expect(200)).body;
    expect(delivery).toMatchObject({ id: headers['x-octap-event-id'], status: 'DELIVERED', lastResponseStatus: 200, attemptCount: 1 });
  });

  it('a failing receiver gets a retry scheduled; a dead-lettered delivery can be replayed under the same id', async () => {
    await ctx.http().post('/v1/webhooks/endpoints').set(auth).send({ url: receiver.url }).expect(201);
    receiver.status = 503;
    await ctx.http().post('/v1/credits/redeem').set(auth).send({ organizationEndUserId: memberId, pointsAmount: 1, idempotencyKey: 'r' }).expect(201);
    await deliverDue();

    const [pending] = (await ctx.http().get('/v1/webhooks/deliveries').set(auth).expect(200)).body;
    expect(pending).toMatchObject({ status: 'PENDING', lastResponseStatus: 503, lastError: 'HTTP 503' });
    await ctx.http().post(`/v1/webhooks/deliveries/${pending.id}/replay`).set(auth).expect(400);

    await ctx.app.get(WebhooksRepository).markDeadLetter(pending.id, 503, 'HTTP 503');
    const replayed = await ctx.http().post(`/v1/webhooks/deliveries/${pending.id}/replay`).set(auth).expect(201);
    expect(replayed.body).toMatchObject({ id: pending.id, status: 'PENDING', attemptCount: 0 });

    receiver.status = 200;
    await deliverDue();
    expect(receiver.received.at(-1)?.headers['x-octap-event-id']).toBe(pending.id);
  });

  it('disable stops deliveries, enable resumes them, rotate-secret returns a new secret once', async () => {
    const endpoint = (await ctx.http().post('/v1/webhooks/endpoints').set(auth).send({ url: receiver.url }).expect(201)).body;

    await ctx.http().post(`/v1/webhooks/endpoints/${endpoint.id}/disable`).set(auth).expect(201);
    await ctx.http().post('/v1/credits/redeem').set(auth).send({ organizationEndUserId: memberId, pointsAmount: 1, idempotencyKey: 'r-1' }).expect(201);
    await deliverDue();
    expect(receiver.received).toEqual([]);

    await ctx.http().post(`/v1/webhooks/endpoints/${endpoint.id}/enable`).set(auth).expect(201);
    const rotated = (await ctx.http().post(`/v1/webhooks/endpoints/${endpoint.id}/rotate-secret`).set(auth).expect(201)).body;
    expect(rotated.secret).not.toBe(endpoint.secret);

    await ctx.http().post('/v1/credits/redeem').set(auth).send({ organizationEndUserId: memberId, pointsAmount: 1, idempotencyKey: 'r-2' }).expect(201);
    await deliverDue();
    const [{ headers, body }] = receiver.received;
    expect(verifyWebhookSignature(body, headers['x-octap-signature'] as string, rotated.secret)).toBe(true);
  });

  it('validates the URL and hides other tenants’ endpoints', async () => {
    const other = await seedOrganization(ctx.db);
    const otherAuth = { authorization: `Bearer ${(await seedCredential(ctx.db, other.id)).rawKey}` };
    const endpoint = (await ctx.http().post('/v1/webhooks/endpoints').set(auth).send({ url: receiver.url }).expect(201)).body;

    await ctx.http().post('/v1/webhooks/endpoints').set(auth).send({}).expect(400);
    await ctx.http().post('/v1/webhooks/endpoints').set(auth).send({ url: 'ftp://nope' }).expect(400);
    await ctx.http().post(`/v1/webhooks/endpoints/${endpoint.id}/disable`).set(otherAuth).expect(404);
  });
});
