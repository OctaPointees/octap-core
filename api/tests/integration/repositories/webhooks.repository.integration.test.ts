import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  DELIVERY_CLAIM_LEASE_MS,
  WebhooksRepository,
  enqueueWebhookEvent,
} from '#infra/db/repositories/webhooks.repository.js';
import { connectTestDb, resetDb, schema, seedOrganization } from '../support/db.js';

const { db, client } = connectTestDb();
const repo = new WebhooksRepository(db);

let orgId: string;
let endpointId: string;

beforeEach(async () => {
  await resetDb(client);
  orgId = (await seedOrganization(db)).id;
  endpointId = (
    await repo.createEndpoint({
      organizationId: orgId,
      url: 'https://merchant.example/hooks',
      secret: 'whsec_1',
      description: 'pos',
    })
  ).id;
});

afterAll(async () => {
  await client.end();
});

const deliveryRow = async (id: string) =>
  (await db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, id)))[0];
const enqueue = (eventType = 'credits.earned') =>
  repo.enqueueDelivery({ organizationId: orgId, endpointId, eventType, payload: { a: 1 } });

describe('endpoints', () => {
  it('lists, finds (tenant-scoped), toggles, and rotates', async () => {
    const other = await seedOrganization(db);

    expect((await repo.listEndpoints(orgId)).map((e) => e.id)).toEqual([endpointId]);
    expect(await repo.listEndpoints(other.id)).toEqual([]);
    expect((await repo.findEndpointForOrganization(orgId, endpointId))?.description).toBe('pos');
    expect(await repo.findEndpointForOrganization(other.id, endpointId)).toBeUndefined();
    expect((await repo.findEndpointById(endpointId))?.secret).toBe('whsec_1');

    expect((await repo.setEndpointStatus(endpointId, 'DISABLED')).status).toBe('DISABLED');
    expect(await repo.listActiveEndpoints(orgId)).toEqual([]);
    await repo.setEndpointStatus(endpointId, 'ACTIVE');
    expect((await repo.listActiveEndpoints(orgId)).map((e) => e.id)).toEqual([endpointId]);

    expect((await repo.rotateEndpointSecret(endpointId, 'whsec_2')).secret).toBe('whsec_2');
  });
});

describe('deliveries', () => {
  it('enqueues PENDING, due now, with no attempts yet; listing is tenant-scoped', async () => {
    const delivery = await enqueue();
    expect(delivery).toMatchObject({
      status: 'PENDING',
      attemptCount: 0,
      eventType: 'credits.earned',
      payload: { a: 1 },
    });

    const other = await seedOrganization(db);
    expect((await repo.listDeliveries(orgId)).map((d) => d.id)).toEqual([delivery.id]);
    expect(await repo.listDeliveries(other.id)).toEqual([]);
    expect((await repo.findDeliveryForOrganization(orgId, delivery.id))?.id).toBe(delivery.id);
    expect(await repo.findDeliveryForOrganization(other.id, delivery.id)).toBeUndefined();
  });

  it('claimDueDeliveries takes only due PENDING rows and bumps the attempt count', async () => {
    const due = await enqueue();
    const future = await enqueue();
    const delivered = await enqueue();
    await repo.scheduleRetry(future.id, new Date(Date.now() + 60_000), 503, 'HTTP 503');
    await repo.markDelivered(delivered.id, 200);

    const claimed = await repo.claimDueDeliveries(10);

    expect(claimed.map((d) => [d.id, d.attemptCount])).toEqual([[due.id, 1]]);
  });

  it('a claimed delivery is leased: invisible to the next poll until the lease lapses', async () => {
    const d = await enqueue();

    const [claimed] = await repo.claimDueDeliveries(10);
    expect(claimed.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + DELIVERY_CLAIM_LEASE_MS - 5_000);
    expect(await repo.claimDueDeliveries(10)).toEqual([]);

    // The claiming worker died mid-attempt: once the lease lapses, the delivery is retried.
    await db
      .update(schema.webhookDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() - 1) })
      .where(eq(schema.webhookDeliveries.id, d.id));
    expect((await repo.claimDueDeliveries(10)).map((r) => [r.id, r.attemptCount])).toEqual([[d.id, 2]]);
  });

  it('two workers racing never claim the same delivery', async () => {
    for (let i = 0; i < 5; i++) {
      await enqueue();
    }
    const [a, b] = await Promise.all([repo.claimDueDeliveries(5), repo.claimDueDeliveries(5)]);
    const ids = [...a, ...b].map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(5);
  });

  it('records delivered / retry / dead-letter outcomes and resets for replay with the same id', async () => {
    const d = await enqueue();

    await repo.scheduleRetry(d.id, new Date(Date.now() + 1000), null, 'ECONNREFUSED');
    expect(await deliveryRow(d.id)).toMatchObject({
      status: 'PENDING',
      lastResponseStatus: null,
      lastError: 'ECONNREFUSED',
    });

    await repo.markDeadLetter(d.id, 500, 'HTTP 500');
    expect(await deliveryRow(d.id)).toMatchObject({
      status: 'DEAD_LETTER',
      lastResponseStatus: 500,
      lastError: 'HTTP 500',
    });

    const replayed = await repo.resetForReplay(d.id);
    expect(replayed).toMatchObject({ id: d.id, status: 'PENDING', attemptCount: 0, lastError: null });

    await repo.markDelivered(d.id, 204);
    expect(await deliveryRow(d.id)).toMatchObject({ status: 'DELIVERED', lastResponseStatus: 204, lastError: null });
  });
});

describe('enqueueWebhookEvent (OCT-209 outbox)', () => {
  it('queues one delivery per ACTIVE endpoint of the organization, on the caller’s transaction', async () => {
    const second = await repo.createEndpoint({
      organizationId: orgId,
      url: 'https://merchant.example/b',
      secret: 'whsec_2',
    });
    const disabled = await repo.createEndpoint({
      organizationId: orgId,
      url: 'https://merchant.example/c',
      secret: 'whsec_3',
    });
    await repo.setEndpointStatus(disabled.id, 'DISABLED');
    const other = await seedOrganization(db);
    await repo.createEndpoint({ organizationId: other.id, url: 'https://other.example', secret: 'whsec_4' });

    const queued = await db.transaction((tx) =>
      enqueueWebhookEvent(tx, {
        organizationId: orgId,
        eventType: 'credits.earn.confirmed',
        payload: { transactionId: 't' },
      }),
    );

    expect(queued).toBe(2);
    const rows = await db.select().from(schema.webhookDeliveries);
    expect(rows.map((r) => r.endpointId).sort()).toEqual([endpointId, second.id].sort());
    expect(rows.every((r) => r.status === 'PENDING' && r.eventType === 'credits.earn.confirmed')).toBe(true);
  });

  it('queues nothing for an organization without active endpoints, and rolls back with its transaction', async () => {
    const bare = await seedOrganization(db);
    await expect(
      db.transaction((tx) => enqueueWebhookEvent(tx, { organizationId: bare.id, eventType: 'x', payload: {} })),
    ).resolves.toBe(0);

    await expect(
      db.transaction(async (tx) => {
        await enqueueWebhookEvent(tx, { organizationId: orgId, eventType: 'credits.earn.confirmed', payload: {} });
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');

    expect(await db.select().from(schema.webhookDeliveries)).toEqual([]);
  });
});
