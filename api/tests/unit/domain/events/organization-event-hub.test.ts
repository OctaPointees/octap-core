import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrganizationStreamEvent } from '@octap/contracts';
import { LATE_COMMIT_WINDOW_MS, OrganizationEventHub } from '#domain/events/organization-event-hub.js';
import type { OrganizationEvent, OrganizationEventsRepository } from '#infra/db/repositories/events.repository.js';
import { stub } from '../../../helpers/stub.js';

const event = (sequence: number, organizationId = 'org-a'): OrganizationEvent => ({
  id: `evt-${sequence}`,
  sequence,
  organizationId,
  type: 'voucher.paused',
  payload: { voucherId: `v-${sequence}`, batchId: null },
  createdAt: new Date('2026-11-25T10:00:00Z'),
});

/** A table the test adds committed rows to; `scanSince` reads it like the repository does. */
function table(latest = 0) {
  const rows: OrganizationEvent[] = [];
  const scanSince = vi.fn(async (organizationIds: string[], after: number, limit: number) =>
    rows
      .filter((r) => organizationIds.includes(r.organizationId) && r.sequence > after)
      .sort((a, b) => a.sequence - b.sequence)
      .slice(0, limit),
  );
  const repo = stub<OrganizationEventsRepository>({ latestSequence: async () => latest, scanSince });
  return { rows, scanSince, hub: new OrganizationEventHub(repo) };
}

const received = () => {
  const seen: OrganizationStreamEvent[] = [];
  return { seen, listener: (e: OrganizationStreamEvent) => void seen.push(e) };
};

describe('OrganizationEventHub', () => {
  let unsubscribe: (() => void) | undefined;
  // The loop's own interval stays still: each test drives the scans itself.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    unsubscribe?.();
    unsubscribe = undefined;
    vi.useRealTimers();
  });

  it('starts from the latest event, and hands each new one only to its own organization, once', async () => {
    const { rows, hub } = table(10);
    rows.push(event(9));
    const a = received();
    const b = received();
    unsubscribe = hub.subscribe('org-a', a.listener);
    const offB = hub.subscribe('org-b', b.listener);

    rows.push(event(11), event(12, 'org-b'));
    await hub.pollOnce(1_000);
    await hub.pollOnce(2_000);

    expect(a.seen.map((e) => e.sequence)).toEqual([11]);
    expect(b.seen.map((e) => e.sequence)).toEqual([12]);
    offB();
  });

  it('still delivers an event that commits after a higher one, within the window', async () => {
    const { rows, hub } = table(0);
    const a = received();
    unsubscribe = hub.subscribe('org-a', a.listener);

    rows.push(event(2));
    await hub.pollOnce(1_000);
    // Sequence 1 was numbered first but its transaction commits only now.
    rows.push(event(1));
    await hub.pollOnce(2_000);

    expect(a.seen.map((e) => e.sequence)).toEqual([2, 1]);
  });

  it('stops reading again what settled once the window has passed', async () => {
    const { rows, hub, scanSince } = table(0);
    unsubscribe = hub.subscribe('org-a', received().listener);
    rows.push(event(1), event(2));
    await hub.pollOnce(0);
    await hub.pollOnce(LATE_COMMIT_WINDOW_MS + 1);
    await hub.pollOnce(LATE_COMMIT_WINDOW_MS + 2);
    expect(scanSince.mock.calls.at(-1)?.[1]).toBe(2);
  });

  it('pages through a window holding more than one page of events', async () => {
    const { rows, hub, scanSince } = table(0);
    const a = received();
    unsubscribe = hub.subscribe('org-a', a.listener);
    for (let i = 1; i <= 1001; i++) rows.push(event(i));
    await hub.pollOnce(0);
    expect(a.seen).toHaveLength(1001);
    expect(scanSince).toHaveBeenCalledTimes(2);
  });

  it('a listener that throws does not keep the others from the event', async () => {
    const { rows, hub } = table(0);
    const a = received();
    unsubscribe = hub.subscribe('org-a', () => {
      throw new Error('socket gone');
    });
    const off = hub.subscribe('org-a', a.listener);
    rows.push(event(1));
    await hub.pollOnce(0);
    expect(a.seen).toHaveLength(1);
    off();
  });

  it('a failed scan is logged and the next one carries on', async () => {
    const { rows, hub, scanSince } = table(0);
    const a = received();
    unsubscribe = hub.subscribe('org-a', a.listener);
    scanSince.mockRejectedValueOnce(new Error('db down'));
    rows.push(event(1));
    await hub.pollOnce(0);
    await hub.pollOnce(1_000);
    expect(a.seen.map((e) => e.sequence)).toEqual([1]);
  });

  it('polls only while someone listens, and starts afresh from the latest event after', async () => {
    const { rows, hub, scanSince } = table(0);
    await hub.pollOnce(0);
    expect(scanSince).not.toHaveBeenCalled();

    const off = hub.subscribe('org-a', received().listener);
    rows.push(event(1));
    await hub.pollOnce(0);
    off();
    await hub.pollOnce(1_000);
    expect(scanSince).toHaveBeenCalledTimes(1);
    hub.onModuleDestroy();
  });
});
