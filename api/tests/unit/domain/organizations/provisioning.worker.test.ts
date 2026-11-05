import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrganizationProvisioningWorker } from '#domain/organizations/provisioning.worker.js';
import type { OperationsRepository } from '#infra/db/repositories/operations.repository.js';
import type { BudgetTopUpProcessor } from '#domain/organizations/budget-top-up.processor.js';
import type { OrganizationProvisioningProcessor } from '#domain/organizations/provisioning.processor.js';

describe('organization provisioning worker lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it('is disabled unless explicitly configured and stops its timer on shutdown', async () => {
    vi.useFakeTimers();
    const claim = vi.fn(async () => []);
    const operations = { recoverStaleProcessing: vi.fn(async () => []), claimNextPending: claim };
    const worker = new OrganizationProvisioningWorker(
      operations as unknown as OperationsRepository,
      {} as OrganizationProvisioningProcessor,
      {} as BudgetTopUpProcessor,
    );
    vi.stubEnv('ORG_PROVISION_WORKER_ENABLED', 'false');
    worker.onModuleInit();
    await vi.advanceTimersByTimeAsync(1000);
    expect(claim).not.toHaveBeenCalled();
    vi.stubEnv('ORG_PROVISION_WORKER_ENABLED', 'true');
    vi.stubEnv('ORG_PROVISION_POLL_INTERVAL_MS', '100');
    worker.onModuleInit();
    await vi.advanceTimersByTimeAsync(200);
    expect(claim).toHaveBeenCalled();
    worker.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('processes each claimed job and avoids overlapping polls', async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const process = vi.fn(async () => {
      await wait;
    });
    const claimNextPending = vi.fn(async () => [{ id: 'job' }]);
    const worker = new OrganizationProvisioningWorker(
      { recoverStaleProcessing: async () => [], claimNextPending } as unknown as OperationsRepository,
      { process } as unknown as OrganizationProvisioningProcessor,
      {} as BudgetTopUpProcessor,
    );
    const first = worker.pollOnce();
    await vi.waitFor(() => expect(process).toHaveBeenCalledOnce());
    await worker.pollOnce();
    expect(claimNextPending).toHaveBeenCalledOnce();
    release();
    await first;
    worker.onModuleDestroy();
  });
  it('sends a top-up to the top-up processor', async () => {
    const provision = vi.fn(async () => {});
    const topUp = vi.fn(async () => {});
    const worker = new OrganizationProvisioningWorker(
      {
        recoverStaleProcessing: async () => [],
        claimNextPending: async () => [{ id: 'job', commandType: 'ORGANIZATION_BUDGET_TOP_UP' }],
      } as unknown as OperationsRepository,
      { process: provision } as unknown as OrganizationProvisioningProcessor,
      { process: topUp } as unknown as BudgetTopUpProcessor,
    );
    await worker.pollOnce();
    expect(topUp).toHaveBeenCalledOnce();
    expect(provision).not.toHaveBeenCalled();
  });
  it('logs a safe error and can poll again after database failure', async () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const recover = vi.fn().mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValue([]);
    const claim = vi.fn(async () => []);
    const worker = new OrganizationProvisioningWorker(
      { recoverStaleProcessing: recover, claimNextPending: claim } as unknown as OperationsRepository,
      {} as OrganizationProvisioningProcessor,
      {} as BudgetTopUpProcessor,
    );
    await worker.pollOnce();
    expect(log).toHaveBeenCalledOnce();
    await worker.pollOnce();
    expect(claim).toHaveBeenCalledOnce();
  });
});
