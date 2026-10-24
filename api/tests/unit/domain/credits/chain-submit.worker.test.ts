import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChainSubmitWorker } from '#domain/credits/chain-submit.worker.js';
import type { ChainSubmitProcessor } from '#domain/credits/chain-submit.processor.js';
import type { ChainOutcomeReconciler } from '#domain/credits/chain-outcome.reconciler.js';
import type { OperationsRepository } from '#infra/db/repositories/operations.repository.js';
import { stub } from '../../../helpers/stub.js';
import { buildOperation } from '../../../helpers/fixtures.js';

const POLL_INTERVAL_MS = 3000;
const RECONCILE_INTERVAL_MS = 60_000;
const idleReconciler = () => stub<ChainOutcomeReconciler>({ reconcileOnce: async () => [] });

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
      idleReconciler(),
    );

    worker.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    worker.onModuleDestroy();

    expect(recoverStaleProcessing).toHaveBeenCalledWith(
      ['CREDIT_EARN_CHAIN_SUBMIT', 'CREDIT_REVERSAL_CHAIN_SUBMIT'],
      5 * 60 * 1000,
    );
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
      idleReconciler(),
    );

    worker.onModuleInit();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    worker.onModuleDestroy();

    expect(claimNextPending).toHaveBeenCalledWith(['CREDIT_EARN_CHAIN_SUBMIT', 'CREDIT_REVERSAL_CHAIN_SUBMIT'], 5);
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
      idleReconciler(),
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
      idleReconciler(),
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
      idleReconciler(),
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
      idleReconciler(),
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
      idleReconciler(),
    );

    worker.onModuleInit();
    worker.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

    expect(claimNextPending).not.toHaveBeenCalled();
  });

  it('onModuleDestroy before init is a no-op', () => {
    const worker = new ChainSubmitWorker(stub<OperationsRepository>(), stub<ChainSubmitProcessor>(), idleReconciler());
    expect(() => worker.onModuleDestroy()).not.toThrow();
  });

  describe('outcome reconciliation (OCT-52)', () => {
    const quietOps = () =>
      stub<OperationsRepository>({ recoverStaleProcessing: async () => [], claimNextPending: async () => [] });

    it('runs the reconciler on its own interval', async () => {
      const reconcileOnce = vi.fn(async () => []);
      const worker = new ChainSubmitWorker(
        quietOps(),
        stub<ChainSubmitProcessor>(),
        stub<ChainOutcomeReconciler>({ reconcileOnce }),
      );

      worker.onModuleInit();
      await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS - 1);
      expect(reconcileOnce).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS + 1);
      worker.onModuleDestroy();

      expect(reconcileOnce).toHaveBeenCalledTimes(2);
    });

    it('never runs two passes at once, and a failed pass is logged and retried', async () => {
      let release!: () => void;
      const reconcileOnce = vi
        .fn()
        .mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve([]))))
        .mockRejectedValueOnce(new Error('rpc down'))
        .mockRejectedValueOnce('string failure')
        .mockResolvedValue([]);
      const worker = new ChainSubmitWorker(
        quietOps(),
        stub<ChainSubmitProcessor>(),
        stub<ChainOutcomeReconciler>({ reconcileOnce }),
      );

      worker.onModuleInit();
      await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS * 3);
      expect(reconcileOnce).toHaveBeenCalledOnce();

      release();
      await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS * 3);
      worker.onModuleDestroy();
      expect(reconcileOnce).toHaveBeenCalledTimes(4);
    });

    it('stops reconciling after onModuleDestroy', async () => {
      const reconcileOnce = vi.fn(async () => []);
      const worker = new ChainSubmitWorker(
        quietOps(),
        stub<ChainSubmitProcessor>(),
        stub<ChainOutcomeReconciler>({ reconcileOnce }),
      );

      worker.onModuleInit();
      worker.onModuleDestroy();
      await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS * 3);

      expect(reconcileOnce).not.toHaveBeenCalled();
    });
  });
});
