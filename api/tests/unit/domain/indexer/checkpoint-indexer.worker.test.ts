import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckpointIndexerWorker } from '#domain/indexer/checkpoint-indexer.worker.js';
import type { CheckpointIndexerProcessor } from '#domain/indexer/checkpoint-indexer.processor.js';
import { IndexerCursorMovedError } from '#infra/db/repositories/indexer.repository.js';
import { stub } from '../../../helpers/stub.js';

const POLL_INTERVAL_MS = 5000;
const MAX_PAGES_PER_POLL = 20;

function worker(processNextPage: () => Promise<boolean>) {
  return new CheckpointIndexerWorker(stub<CheckpointIndexerProcessor>({ processNextPage }));
}

describe('CheckpointIndexerWorker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drains pages until the processor reports no more', async () => {
    const processNextPage = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
    const w = worker(processNextPage);

    w.onModuleInit();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    w.onModuleDestroy();

    expect(processNextPage).toHaveBeenCalledTimes(3);
  });

  it('caps one poll’s catch-up at MAX_PAGES_PER_POLL pages', async () => {
    const processNextPage = vi.fn(async () => true);
    const w = worker(processNextPage);

    w.onModuleInit();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    w.onModuleDestroy();

    expect(processNextPage).toHaveBeenCalledTimes(MAX_PAGES_PER_POLL);
  });

  it('a cursor moved by another instance is not fatal: the loop re-reads and continues', async () => {
    const processNextPage = vi
      .fn()
      .mockRejectedValueOnce(new IndexerCursorMovedError('octap::credit_account'))
      .mockResolvedValue(false);
    const w = worker(processNextPage);

    w.onModuleInit();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    w.onModuleDestroy();

    expect(processNextPage).toHaveBeenCalledTimes(2);
  });

  it('any other failure ends this poll, and the next tick retries', async () => {
    const processNextPage = vi
      .fn()
      .mockRejectedValueOnce(new Error('grpc unavailable'))
      .mockRejectedValueOnce('string failure')
      .mockResolvedValue(false);
    const w = worker(processNextPage);

    w.onModuleInit();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    w.onModuleDestroy();

    expect(processNextPage).toHaveBeenCalledTimes(3);
  });

  it('never runs two polls at once', async () => {
    let release!: (more: boolean) => void;
    const processNextPage = vi.fn(() => new Promise<boolean>((resolve) => (release = resolve)));
    const w = worker(processNextPage);

    w.onModuleInit();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(processNextPage).toHaveBeenCalledOnce();

    release(false);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    w.onModuleDestroy();
    expect(processNextPage).toHaveBeenCalledTimes(2);
  });

  it('stops mid-catch-up once destroyed', async () => {
    const processNextPage = vi.fn(async () => {
      w.onModuleDestroy();
      return true;
    });
    const w = worker(processNextPage);

    w.onModuleInit();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);

    expect(processNextPage).toHaveBeenCalledOnce();
  });

  it('onModuleDestroy before init is a no-op', () => {
    expect(() => worker(async () => false).onModuleDestroy()).not.toThrow();
  });
});
