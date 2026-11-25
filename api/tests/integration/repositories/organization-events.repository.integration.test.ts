import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OrganizationEventsRepository } from '#infra/db/repositories/events.repository.js';
import { connectTestDb, resetDb, schema, seedOrganization } from '../support/db.js';

const { db, client } = connectTestDb();
const repo = new OrganizationEventsRepository(db);
const DAY = 86_400_000;

let orgA: string;
let orgB: string;
let endpointA: string;

beforeEach(async () => {
  await resetDb(client);
  orgA = (await seedOrganization(db)).id;
  orgB = (await seedOrganization(db)).id;
  [{ id: endpointA }] = await db
    .insert(schema.webhookEndpoints)
    .values({ organizationId: orgA, url: 'https://a.example/hook', secret: 's' })
    .returning();
});
afterAll(() => client.end());

const record = async (organizationId: string, createdAt = new Date()) =>
  (
    await db
      .insert(schema.organizationEvents)
      .values({ organizationId, type: 'budget.low', payload: { threshold: 80 }, createdAt })
      .returning()
  )[0];

describe('OrganizationEventsRepository', () => {
  it('scans only the organizations asked for, after a sequence, oldest first', async () => {
    const a1 = await record(orgA);
    const b1 = await record(orgB);
    const a2 = await record(orgA);

    expect(await repo.latestSequence()).toBe(a2.sequence);
    expect((await repo.scanSince([orgA], 0, 10)).map((e) => e.id)).toEqual([a1.id, a2.id]);
    expect((await repo.scanSince([orgA, orgB], a1.sequence, 10)).map((e) => e.id)).toEqual([b1.id, a2.id]);
    expect(await repo.scanSince([orgA], 0, 1)).toHaveLength(1);
    expect(await repo.scanSince([], 0, 10)).toEqual([]);
  });

  it('replays and finds an anchor only within the organization', async () => {
    const a1 = await record(orgA);
    const b1 = await record(orgB);
    const a2 = await record(orgA);

    expect((await repo.replaySince(orgA, a1.sequence, 10)).map((e) => e.id)).toEqual([a2.id]);
    expect(await repo.hasEvent(orgA, a1.sequence)).toBe(true);
    expect(await repo.hasEvent(orgA, b1.sequence)).toBe(false);
    expect(await repo.hasEvent(orgA, 999_999)).toBe(false);
  });

  it('deletes old events, oldest first, but keeps those still owed or replayable', async () => {
    const old = new Date(Date.now() - 40 * DAY);
    const delivered = await record(orgA, old);
    const pending = await record(orgA, old);
    const deadLetter = await record(orgA, old);
    const noEndpoint = await record(orgB, old);
    const recent = await record(orgA);
    await db.insert(schema.webhookDeliveries).values([
      { organizationId: orgA, endpointId: endpointA, eventId: delivered.id, status: 'DELIVERED' },
      { organizationId: orgA, endpointId: endpointA, eventId: pending.id, status: 'PENDING' },
      { organizationId: orgA, endpointId: endpointA, eventId: deadLetter.id, status: 'DEAD_LETTER' },
    ]);
    const before = new Date(Date.now() - 30 * DAY);

    expect(await repo.deleteExpired(before, 1)).toBe(1);
    expect(await repo.deleteExpired(before, 10)).toBe(1);
    expect(await repo.deleteExpired(before, 10)).toBe(0);

    const left = (await db.select().from(schema.organizationEvents)).map((e) => e.id).sort();
    expect(left).toEqual([pending.id, deadLetter.id, recent.id].sort());
    expect(left).not.toContain(noEndpoint.id);
    // The delivered event's delivery went with it.
    expect((await db.select().from(schema.webhookDeliveries)).map((d) => d.eventId).sort()).toEqual(
      [pending.id, deadLetter.id].sort(),
    );
  });
});
