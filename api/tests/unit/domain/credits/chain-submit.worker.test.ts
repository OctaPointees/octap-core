import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChainSubmitWorker } from '../../../../src/domain/credits/chain-submit.worker.js';
import type { ChainSubmitProcessor } from '../../../../src/domain/credits/chain-submit.processor.js';
import type { OperationsRepository } from '../../../../src/infra/db/repositories/operations.repository.js';
import { stub } from '../../../helpers/stub.js';
import { buildOperation } from '../../../helpers/fixtures.js';

const POLL_INTERVAL_MS = 3000;

describe('ChainSubmitWorker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('recovers stale PROCESSING rows of its own command type once at startup', async () => {
    const recoverStaleProcessing = vi.fn(async () => [buildOperation({ id: 'op-stuck' })]);
    const worker = new ChainSubmitWorker(
      stub<OperationsRepository>({ recoverStaleProcessing, claimNextPending: async () => [] }),
      stub<ChainSubmitProcessor>(),
    );

    worker.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    worker.onModuleDestroy();

    expect(recoverStaleProcessing).toHaveBeenCalledWith(['CREDIT_EARN_CHAIN_SUBMIT'], 5 * 60 * 1000);
  });

  it('a failing startup recovery is logged, not fatal, and polling still starts', async () => {
    const claimNextPending = vi.fn(async () => []);
    const worker = new ChainSubmitWorker(
      stub<OperationsRepository>({
        recoverStaleProcessing: async () => {
          throw new Error('db not up yet');
        },
        claimNextPending,
      }),
      stub<ChainSubmitProcessor>(),
    );

    worker.onModuleInit();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    worker.onModuleDestroy();

    expect(claimNextPending).toHaveBeenCalledWith(['CREDIT_EARN_CHAIN_SUBMIT'], 5);
  });

  it('a non-Error startup recovery failure is also swallowed', async () => {
    const worker = new ChainSubmitWorker(
      stub<OperationsRepository>({
        recoverStaleProcessing: async () => {
          throw 'nope';
        },
        claimNextPending: async () => [],
      }),
      stub<ChainSubmitProcessor>(),
    );

    worker.onModuleInit();
    await expect(vi.advanceTimersByTimeAsync(0)).resolves.toBeDefined();
    worker.onModuleDestroy();
  });

  it('processes every claimed operation on each tick', async () => {
    const process = vi.fn<(operation: { id: string }) => Promise<void>>(async () => {});
    const worker = new ChainSubmitWorker(
      stub<OperationsRepository>({
        recoverStaleProcessing: async () => [],
        claimNextPending: async () => [buildOperation({ id: 'op-1' }), buildOperation({ id: 'op-2' })],
      }),
      stub<ChainSubmitProcessor>({ process }),
    );

    worker.onModuleInit();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    worker.onModuleDestroy();

    expect(process.mock.calls.map(([op]) => op.id)).toEqual(['op-1', 'op-2']);
  });

  it('never runs two polls at once', async () => {
    let release!: () => void;
    const claimNextPending = vi.fn(
      () =>
        new Promise<never[]>((resolve) => {
          release = () => resolve([]);
        }),
    );
    const worker = new ChainSubmitWorker(
      stub<OperationsRepository>({ recoverStaleProcessing: async () => [], claimNextPending }),
      stub<ChainSubmitProcessor>(),
    );

    worker.onModuleInit();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(claimNextPending).toHaveBeenCalledOnce();

    release();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    worker.onModuleDestroy();
    expect(claimNextPending).toHaveBeenCalledTimes(2);
  });

  it('a failed poll is logged and the next tick tries again', async () => {
    const claimNextPending = vi
      .fn()
      .mockRejectedValueOnce(new Error('db blip'))
      .mockRejectedValueOnce('string failure')
      .mockResolvedValue([]);
    const worker = new ChainSubmitWorker(
      stub<OperationsRepository>({ recoverStaleProcessing: async () => [], claimNextPending }),
      stub<ChainSubmitProcessor>(),
    );

    worker.onModuleInit();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    worker.onModuleDestroy();

    expect(claimNextPending).toHaveBeenCalledTimes(3);
  });

  it('stops polling after onModuleDestroy', async () => {
    const claimNextPending = vi.fn(async () => []);
    const worker = new ChainSubmitWorker(
      stub<OperationsRepository>({ recoverStaleProcessing: async () => [], claimNextPending }),
      stub<ChainSubmitProcessor>(),
    );

    worker.onModuleInit();
    worker.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

    expect(claimNextPending).not.toHaveBeenCalled();
  });

  it('onModuleDestroy before init is a no-op', () => {
    const worker = new ChainSubmitWorker(stub<OperationsRepository>(), stub<ChainSubmitProcessor>());
    expect(() => worker.onModuleDestroy()).not.toThrow();
  });
});
