import { describe, expect, it, vi } from 'vitest';
import { EVENT_RETENTION_DAYS, EventRetentionWorker } from '#domain/events/event-retention.worker.js';
import type { OrganizationEventsRepository } from '#infra/db/repositories/events.repository.js';
import { stub } from '../../../helpers/stub.js';

describe('EventRetentionWorker', () => {
  it(`deletes what is older than ${EVENT_RETENTION_DAYS} days, batch after batch until one comes back short`, async () => {
    const deleteExpired = vi.fn<(before: Date, limit: number) => Promise<number>>();
    deleteExpired.mockResolvedValueOnce(1000).mockResolvedValueOnce(1000).mockResolvedValueOnce(3);
    const worker = new EventRetentionWorker(stub<OrganizationEventsRepository>({ deleteExpired }));
    const now = new Date('2026-11-25T00:00:00Z');

    expect(await worker.sweepOnce(now)).toBe(2003);
    expect(deleteExpired).toHaveBeenCalledTimes(3);
    expect(deleteExpired.mock.calls[0]).toEqual([new Date('2026-10-26T00:00:00Z'), 1000]);
  });

  it('a failed sweep is logged, and the next one runs', async () => {
    const deleteExpired = vi.fn<(before: Date, limit: number) => Promise<number>>();
    deleteExpired.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(0);
    const worker = new EventRetentionWorker(stub<OrganizationEventsRepository>({ deleteExpired }));
    expect(await worker.sweepOnce()).toBe(0);
    expect(await worker.sweepOnce()).toBe(0);
    expect(deleteExpired).toHaveBeenCalledTimes(2);
  });

  it('starts its interval with the module and stops it with it', () => {
    vi.useFakeTimers();
    const deleteExpired = vi.fn(async () => 0);
    const worker = new EventRetentionWorker(stub<OrganizationEventsRepository>({ deleteExpired }));
    worker.onModuleInit();
    vi.advanceTimersByTime(3_600_000);
    expect(deleteExpired).toHaveBeenCalledOnce();
    worker.onModuleDestroy();
    vi.advanceTimersByTime(3_600_000);
    expect(deleteExpired).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
