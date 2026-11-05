import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { BudgetWarningWorker } from '#domain/credits/budget-warning.worker.js';
import type { IssuanceBudgetService } from '#domain/credits/issuance-budget.service.js';
import { stub } from '../../../helpers/stub.js';

describe('BudgetWarningWorker', () => {
  it('polls on its interval and stops on shutdown', async () => {
    vi.useFakeTimers();
    const checkWarnings = vi.fn(async () => {});
    const worker = new BudgetWarningWorker(stub<IssuanceBudgetService>({ checkWarnings }));
    worker.onModuleInit();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(checkWarnings).toHaveBeenCalledOnce();
    worker.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(checkWarnings).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('does not overlap polls, and survives a failed one', async () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const checkWarnings = vi.fn(async () => {
      await wait;
      throw new Error('database unavailable');
    });
    const worker = new BudgetWarningWorker(stub<IssuanceBudgetService>({ checkWarnings }));
    const first = worker.pollOnce();
    await worker.pollOnce();
    expect(checkWarnings).toHaveBeenCalledOnce();
    release();
    await first;
    expect(log).toHaveBeenCalledOnce();
    await worker.pollOnce();
    expect(checkWarnings).toHaveBeenCalledTimes(2);
  });
});
