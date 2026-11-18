import { describe, expect, it, vi } from 'vitest';
import { ConsoleWebhooksService } from '#domain/webhooks/console-webhooks.service.js';
import type { WebhookDeliveryService } from '#domain/webhooks/webhook-delivery.service.js';
import type { WebhookEndpointsService } from '#domain/webhooks/webhook-endpoints.service.js';
import {
  ConsoleAccessError,
  type ConsoleOrganizationsRepository,
} from '#infra/db/repositories/console-organizations.repository.js';

function setup(access: 'granted' | 'denied' | 'broken' = 'granted') {
  const withOwnerAccess = vi.fn(async (_user: string, _org: string, action: (tx: unknown) => unknown) => {
    if (access === 'denied') throw new ConsoleAccessError();
    if (access === 'broken') throw new Error('database down');
    return action('tx');
  });
  const withAccess = vi.fn();
  const endpoints = {
    list: vi.fn(async () => []),
    register: vi.fn(async () => ({ id: 'ep', secret: 'whsec_x' })),
    disable: vi.fn(async () => ({ id: 'ep' })),
    enable: vi.fn(async () => ({ id: 'ep' })),
    rotateSecret: vi.fn(async () => ({ id: 'ep', secret: 'whsec_y' })),
  };
  const deliveries = { list: vi.fn(async () => []), replay: vi.fn(async () => ({ id: 'dl' })) };
  const service = new ConsoleWebhooksService(
    { withOwnerAccess, withAccess } as unknown as ConsoleOrganizationsRepository,
    endpoints as unknown as WebhookEndpointsService,
    deliveries as unknown as WebhookDeliveryService,
  );
  return { service, withOwnerAccess, withAccess, endpoints, deliveries };
}

describe('ConsoleWebhooksService', () => {
  it('runs every route inside the Owner check, on its transaction', async () => {
    const { service, withOwnerAccess, withAccess, endpoints, deliveries } = setup();
    await service.listEndpoints('user', 'org');
    await service.registerEndpoint('user', 'org', { url: 'https://x', description: 'pos' });
    await service.disableEndpoint('user', 'org', 'ep');
    await service.enableEndpoint('user', 'org', 'ep');
    await service.rotateSecret('user', 'org', 'ep');
    await service.listDeliveries('user', 'org');
    await service.replayDelivery('user', 'org', 'dl');

    expect(withOwnerAccess).toHaveBeenCalledTimes(7);
    for (const call of withOwnerAccess.mock.calls) expect(call.slice(0, 2)).toEqual(['user', 'org']);
    // Never the Owner-or-Business-Developer check: a Business Developer reads nothing here either.
    expect(withAccess).not.toHaveBeenCalled();
    expect(endpoints.list).toHaveBeenCalledWith('org', 'tx');
    expect(endpoints.register).toHaveBeenCalledWith('org', 'https://x', 'pos', 'tx');
    expect(endpoints.disable).toHaveBeenCalledWith('org', 'ep', 'tx');
    expect(endpoints.enable).toHaveBeenCalledWith('org', 'ep', 'tx');
    expect(endpoints.rotateSecret).toHaveBeenCalledWith('org', 'ep', 'tx');
    expect(deliveries.list).toHaveBeenCalledWith('org', 'tx');
    expect(deliveries.replay).toHaveBeenCalledWith('org', 'dl', 'tx');
  });

  it('checks the body before the database', () => {
    const { service, withOwnerAccess } = setup();
    for (const body of [null, [], 'x', {}, { url: 7 }, { url: 'https://x', description: 7 }])
      expect(() => service.registerEndpoint('user', 'org', body as never)).toThrow(
        expect.objectContaining({ status: 400 }),
      );
    expect(withOwnerAccess).not.toHaveBeenCalled();
  });

  it('turns a refused Owner check into 403 and passes other failures through', async () => {
    await expect(setup('denied').service.listEndpoints('user', 'org')).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/Only an active Owner/),
    });
    await expect(setup('broken').service.listDeliveries('user', 'org')).rejects.toThrow('database down');
  });
});
