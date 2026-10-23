import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebhookDeliveryWorker } from '#domain/webhooks/webhook-delivery.worker.js';
import type { WebhookDeliveryProcessor } from '#domain/webhooks/webhook-delivery.processor.js';
import type { WebhooksRepository } from '#infra/db/repositories/webhooks.repository.js';
import { stub } from '../../../helpers/stub.js';

const POLL_INTERVAL_MS = 3000;

describe('WebhookDeliveryWorker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('claims due deliveries in batches of 10 and processes each', async () => {
    const claimDueDeliveries = vi.fn(async () => [{ id: 'dlv-1' }, { id: 'dlv-2' }]);
    const process = vi.fn<(delivery: { id: string }) => Promise<void>>(async () => {});
    const worker = new WebhookDeliveryWorker(
      stub<WebhooksRepository>({ claimDueDeliveries }),
      stub<WebhookDeliveryProcessor>({ process }),
    );

    worker.onModuleInit();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    worker.onModuleDestroy();

    expect(claimDueDeliveries).toHaveBeenCalledWith(10);
    expect(process.mock.calls.map(([d]) => d.id)).toEqual(['dlv-1', 'dlv-2']);
  });

  it('never runs two polls at once', async () => {
    let release!: () => void;
    const claimDueDeliveries = vi.fn(() => new Promise<never[]>((resolve) => (release = () => resolve([]))));
    const worker = new WebhookDeliveryWorker(
      stub<WebhooksRepository>({ claimDueDeliveries }),
      stub<WebhookDeliveryProcessor>(),
    );

    worker.onModuleInit();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(claimDueDeliveries).toHaveBeenCalledOnce();

    release();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    worker.onModuleDestroy();
    expect(claimDueDeliveries).toHaveBeenCalledTimes(2);
  });

  it('a failed poll is logged and the next tick tries again', async () => {
    const claimDueDeliveries = vi
      .fn()
      .mockRejectedValueOnce(new Error('db blip'))
      .mockRejectedValueOnce('nope')
      .mockResolvedValue([]);
    const worker = new WebhookDeliveryWorker(
      stub<WebhooksRepository>({ claimDueDeliveries }),
      stub<WebhookDeliveryProcessor>(),
    );

    worker.onModuleInit();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    worker.onModuleDestroy();

    expect(claimDueDeliveries).toHaveBeenCalledTimes(3);
  });

  it('stops polling after onModuleDestroy, which is also safe before init', async () => {
    const claimDueDeliveries = vi.fn(async () => []);
    const worker = new WebhookDeliveryWorker(
      stub<WebhooksRepository>({ claimDueDeliveries }),
      stub<WebhookDeliveryProcessor>(),
    );

    worker.onModuleDestroy();
    worker.onModuleInit();
    worker.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

    expect(claimDueDeliveries).not.toHaveBeenCalled();
  });
});
