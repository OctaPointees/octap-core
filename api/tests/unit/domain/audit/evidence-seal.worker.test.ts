import { afterEach, describe, expect, it, vi } from 'vitest';
import { EvidenceSealWorker } from '#domain/audit/evidence-seal.worker.js';
import type { EvidenceSealProcessor } from '#domain/audit/evidence-seal.processor.js';

function worker(runOnce: () => Promise<{ sealed: number; archived: number }>) {
  const processor = { runOnce: vi.fn(runOnce) };
  return { processor, worker: new EvidenceSealWorker(processor as unknown as EvidenceSealProcessor) };
}

describe('EvidenceSealWorker', () => {
  afterEach(() => vi.useRealTimers());

  it('stays off unless EVIDENCE_SEAL_ENABLED is true', () => {
    vi.useFakeTimers();
    const { processor, worker: w } = worker(async () => ({ sealed: 0, archived: 0 }));
    w.onModuleInit();
    vi.advanceTimersByTime(600_000);
    expect(processor.runOnce).not.toHaveBeenCalled();
    w.onModuleDestroy();
  });

  it('runs at start and on every interval once enabled, and stops on shutdown', async () => {
    vi.useFakeTimers();
    vi.stubEnv('EVIDENCE_SEAL_ENABLED', 'true');
    const { processor, worker: w } = worker(async () => ({ sealed: 1, archived: 1 }));
    w.onModuleInit();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(processor.runOnce).toHaveBeenCalledTimes(2);
    w.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(processor.runOnce).toHaveBeenCalledTimes(2);
  });

  it('skips a tick while the previous run is still going, and survives a failed run', async () => {
    let release!: () => void;
    const { processor, worker: w } = worker(
      () => new Promise((resolve) => (release = () => resolve({ sealed: 0, archived: 0 }))),
    );
    const first = w.tick();
    await w.tick();
    expect(processor.runOnce).toHaveBeenCalledTimes(1);
    release();
    await first;
    processor.runOnce.mockRejectedValueOnce(new Error('db down'));
    await expect(w.tick()).resolves.toBeUndefined();
    expect(processor.runOnce).toHaveBeenCalledTimes(2);
  });
});
