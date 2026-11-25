import { describe, expect, it, vi } from 'vitest';
import { REQUEST_LOG_RETENTION_DAYS } from '@octap/contracts';
import { RequestLogRetentionWorker } from '#domain/developer/request-log-retention.worker.js';
import type { RequestLogsRepository } from '#infra/db/repositories/request-logs.repository.js';
import { stub } from '../../../helpers/stub.js';

describe('RequestLogRetentionWorker', () => {
  it(`deletes rows older than ${REQUEST_LOG_RETENTION_DAYS} days, batch after batch until one comes back short`, async () => {
    const deleteExpired = vi.fn<(before: Date, limit: number) => Promise<number>>();
    deleteExpired.mockResolvedValueOnce(5000).mockResolvedValueOnce(12);
    const worker = new RequestLogRetentionWorker(stub<RequestLogsRepository>({ deleteExpired }));

    expect(await worker.sweepOnce(new Date('2026-11-26T00:00:00Z'))).toBe(5012);
    expect(deleteExpired).toHaveBeenCalledTimes(2);
    expect(deleteExpired.mock.calls[0]).toEqual([new Date('2026-10-27T00:00:00Z'), 5000]);
  });

  it('a failed sweep is logged, and the next one runs', async () => {
    const deleteExpired = vi.fn<(before: Date, limit: number) => Promise<number>>();
    deleteExpired.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(0);
    const worker = new RequestLogRetentionWorker(stub<RequestLogsRepository>({ deleteExpired }));
    expect(await worker.sweepOnce()).toBe(0);
    expect(await worker.sweepOnce()).toBe(0);
    expect(deleteExpired).toHaveBeenCalledTimes(2);
  });

  it('starts its interval with the module and stops it with it', () => {
    vi.useFakeTimers();
    const deleteExpired = vi.fn(async () => 0);
    const worker = new RequestLogRetentionWorker(stub<RequestLogsRepository>({ deleteExpired }));
    worker.onModuleInit();
    vi.advanceTimersByTime(3_600_000);
    expect(deleteExpired).toHaveBeenCalledOnce();
    worker.onModuleDestroy();
    vi.advanceTimersByTime(3_600_000);
    expect(deleteExpired).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
