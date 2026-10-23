import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_DELIVERY_ATTEMPTS, WebhookDeliveryProcessor } from '#domain/webhooks/webhook-delivery.processor.js';
import { generateWebhookSecret, signWebhookPayload } from '#domain/webhooks/webhook-signing.util.js';
import type { WebhooksRepository } from '#infra/db/repositories/webhooks.repository.js';
import type { webhookDeliveries } from '#infra/db/schema/webhooks.schema.js';
import { stub } from '../../../helpers/stub.js';

const activeEndpoint = (secret = generateWebhookSecret()) => ({
  id: 'ep-1',
  url: 'https://merchant.example/hooks',
  secret,
  status: 'ACTIVE',
});

const delivery = (attemptCount = 1): typeof webhookDeliveries.$inferSelect =>
  ({
    id: 'dlv-1',
    endpointId: 'ep-1',
    eventType: 'credits.earned',
    payload: { a: 1 },
    attemptCount,
  }) as typeof webhookDeliveries.$inferSelect;

describe('WebhookDeliveryProcessor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a successful delivery is signed over the exact body and marked DELIVERED', async () => {
    const secret = generateWebhookSecret();
    const markDelivered = vi.fn(async () => {});
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>>(async () => ({
      ok: true,
      status: 200,
    }));
    vi.stubGlobal('fetch', fetchMock);

    await new WebhookDeliveryProcessor(
      stub<WebhooksRepository>({ findEndpointById: async () => activeEndpoint(secret), markDelivered }),
    ).process(delivery());

    const [url, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(url).toBe('https://merchant.example/hooks');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ id: 'dlv-1', type: 'credits.earned', data: { a: 1 } });
    expect(headers['x-octap-signature']).toBe(signWebhookPayload(init.body as string, secret));
    expect(headers['x-octap-event-id']).toBe('dlv-1');
    expect(headers['x-octap-event-type']).toBe('credits.earned');
    expect(markDelivered).toHaveBeenCalledWith('dlv-1', 200);
  });

  it.each([
    [1, 1],
    [2, 2],
    [3, 5],
    [5, 30],
  ])('a non-2xx response on attempt %d schedules a retry %d minute(s) out', async (attemptCount, minutes) => {
    vi.useFakeTimers({ now: new Date('2026-10-23T00:00:00Z') });
    const scheduleRetry = vi.fn(async () => {});
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 503 }));

    await new WebhookDeliveryProcessor(
      stub<WebhooksRepository>({ findEndpointById: async () => activeEndpoint(), scheduleRetry }),
    ).process(delivery(attemptCount));

    expect(scheduleRetry).toHaveBeenCalledWith('dlv-1', new Date(Date.now() + minutes * 60_000), 503, 'HTTP 503');
  });

  it('a network error schedules a retry with no response status', async () => {
    const scheduleRetry = vi.fn(async () => {});
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });

    await new WebhookDeliveryProcessor(
      stub<WebhooksRepository>({ findEndpointById: async () => activeEndpoint(), scheduleRetry }),
    ).process(delivery());

    expect(scheduleRetry).toHaveBeenCalledWith('dlv-1', expect.any(Date), null, 'ECONNREFUSED');
  });

  it('a non-Error rejection is stringified', async () => {
    const scheduleRetry = vi.fn(async () => {});
    vi.stubGlobal('fetch', async () => {
      throw 'aborted';
    });

    await new WebhookDeliveryProcessor(
      stub<WebhooksRepository>({ findEndpointById: async () => activeEndpoint(), scheduleRetry }),
    ).process(delivery());

    expect(scheduleRetry).toHaveBeenCalledWith('dlv-1', expect.any(Date), null, 'aborted');
  });

  it('exhausting the attempt cap dead-letters instead of retrying again', async () => {
    const markDeadLetter = vi.fn(async () => {});
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500 }));

    await new WebhookDeliveryProcessor(
      stub<WebhooksRepository>({
        findEndpointById: async () => activeEndpoint(),
        markDeadLetter,
        scheduleRetry: () => expect.fail('should not retry past the cap'),
      }),
    ).process(delivery(MAX_DELIVERY_ATTEMPTS));

    expect(markDeadLetter).toHaveBeenCalledWith('dlv-1', 500, 'HTTP 500');
  });

  it.each([
    ['disabled', { id: 'ep-1', status: 'DISABLED' }],
    ['deleted', undefined],
  ])('a %s endpoint dead-letters immediately without an HTTP attempt', async (_label, endpoint) => {
    const markDeadLetter = vi.fn(async () => {});
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await new WebhookDeliveryProcessor(
      stub<WebhooksRepository>({ findEndpointById: async () => endpoint, markDeadLetter }),
    ).process(delivery());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(markDeadLetter).toHaveBeenCalledWith('dlv-1', null, 'Endpoint is disabled or no longer exists');
  });
});
