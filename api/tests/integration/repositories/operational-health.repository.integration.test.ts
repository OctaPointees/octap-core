import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OperationalHealthRepository } from '#infra/db/repositories/operational-health.repository.js';
import { WebhooksRepository } from '#infra/db/repositories/webhooks.repository.js';
import { connectTestDb, resetDb, schema, seedOrganization } from '../support/db.js';

const { db, client } = connectTestDb();
const repo = new OperationalHealthRepository(db);
const ago = (seconds: number) => new Date(Date.now() - seconds * 1000);

let orgA: string;
let orgB: string;

beforeEach(async () => {
  await resetDb(client);
  orgA = (await seedOrganization(db)).id;
  orgB = (await seedOrganization(db)).id;
});

afterAll(async () => {
  await client.end();
});

async function seedOperation(tenantId: string, commandType: string, status: string, ageSeconds: number) {
  await db.insert(schema.operations).values({
    tenantId,
    commandType,
    status,
    idempotencyKey: randomUUID(),
    createdAt: ago(ageSeconds),
  });
}

describe('OperationalHealthRepository', () => {
  it('ping answers against the real database', async () => {
    await expect(repo.ping()).resolves.toBeUndefined();
  });

  it('unsettledOperations groups every tenant by command type and status, ignoring settled rows', async () => {
    await seedOperation(orgA, 'CREDIT_EARN_CHAIN_SUBMIT', 'PENDING', 600);
    await seedOperation(orgB, 'CREDIT_EARN_CHAIN_SUBMIT', 'PENDING', 60);
    await seedOperation(orgA, 'CREDIT_EARN_CHAIN_SUBMIT', 'UNKNOWN', 300);
    await seedOperation(orgB, 'CREDIT_REVERSAL_CHAIN_SUBMIT', 'PROCESSING', 30);
    await seedOperation(orgA, 'CREDIT_EARN_CHAIN_SUBMIT', 'SUBMITTED', 9000);
    await seedOperation(orgA, 'CREDIT_EARN_CHAIN_SUBMIT', 'FAILED', 9000);

    const rows = await repo.unsettledOperations();

    expect(
      rows.map(({ oldestAgeSeconds, ...rest }) => ({ ...rest, age: Math.round(oldestAgeSeconds / 10) * 10 })),
    ).toEqual([
      { commandType: 'CREDIT_EARN_CHAIN_SUBMIT', status: 'PENDING', count: 2, age: 600 },
      { commandType: 'CREDIT_EARN_CHAIN_SUBMIT', status: 'UNKNOWN', count: 1, age: 300 },
      { commandType: 'CREDIT_REVERSAL_CHAIN_SUBMIT', status: 'PROCESSING', count: 1, age: 30 },
    ]);
  });

  it('webhookBacklog counts pending, due and dead-lettered deliveries and the oldest due wait', async () => {
    const endpointId = (
      await new WebhooksRepository(db).createEndpoint({
        organizationId: orgA,
        url: 'https://merchant.example/hooks',
        secret: 'whsec_1',
        description: 'pos',
      })
    ).id;
    const delivery = (status: 'PENDING' | 'DELIVERED' | 'DEAD_LETTER', nextAttemptAt: Date) => ({
      organizationId: orgA,
      endpointId,
      eventType: 'credits.earn.confirmed',
      payload: {},
      status,
      nextAttemptAt,
    });
    await db
      .insert(schema.webhookDeliveries)
      .values([
        delivery('PENDING', ago(120)),
        delivery('PENDING', ago(5)),
        delivery('PENDING', new Date(Date.now() + 3_600_000)),
        delivery('DEAD_LETTER', ago(9000)),
        delivery('DELIVERED', ago(9000)),
      ]);

    const backlog = await repo.webhookBacklog();

    expect(backlog).toMatchObject({ pending: 3, due: 2, deadLettered: 1 });
    expect(backlog.oldestDueAgeSeconds).toBeGreaterThanOrEqual(119);
    expect(backlog.oldestDueAgeSeconds).toBeLessThan(140);
  });

  it('webhookBacklog is zero, with no oldest wait, when nothing is owed', async () => {
    expect(await repo.webhookBacklog()).toEqual({ pending: 0, due: 0, oldestDueAgeSeconds: null, deadLettered: 0 });
  });

  it('indexerStreams reports each stream position and the time since its last write', async () => {
    await db.insert(schema.indexerCursors).values({
      streamName: 'octap::credit_account',
      cursor: 'C1',
      lastCheckpoint: '900',
      caughtUpCheckpoint: '950',
      updatedAt: ago(45),
    });

    const [stream] = await repo.indexerStreams();

    expect(stream).toMatchObject({
      streamName: 'octap::credit_account',
      lastCheckpoint: '900',
      caughtUpCheckpoint: '950',
    });
    expect(stream.sinceUpdateSeconds).toBeGreaterThanOrEqual(44);
    expect(stream.sinceUpdateSeconds).toBeLessThan(60);
  });
});
