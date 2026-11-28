import { describe, expect, it, vi } from 'vitest';
import { ConsoleWebhooksService } from '#domain/webhooks/console-webhooks.service.js';
import type { WebhookDeliveryService } from '#domain/webhooks/webhook-delivery.service.js';
import type { WebhookEndpointsService } from '#domain/webhooks/webhook-endpoints.service.js';
import {
  ConsoleAccessError,
  type ConsoleOrganizationsRepository,
} from '#infra/db/repositories/console-organizations.repository.js';

function setup(access: 'granted' | 'denied' | 'broken' = 'granted') {
  const check = async (_user: string, _org: string, action: (tx: unknown, role?: string) => unknown) => {
    if (access === 'denied') throw new ConsoleAccessError();
    if (access === 'broken') throw new Error('database down');
    return action('tx', 'BUSINESS_DEVELOPER');
  };
  const withOwnerAccess = vi.fn(check);
  const withEditorAccess = vi.fn(check);
  const withAccess = vi.fn();
  const endpoints = {
    list: vi.fn(async () => []),
    register: vi.fn(async () => ({ id: 'ep', secret: 'whsec_x' })),
    disable: vi.fn(async () => ({ id: 'ep' })),
    enable: vi.fn(async () => ({ id: 'ep' })),
    rotateSecret: vi.fn(async () => ({ id: 'ep', secret: 'whsec_y' })),
    sendTest: vi.fn(async () => ({ eventId: 'ev' })),
  };
  const deliveries = { list: vi.fn(async () => []), replay: vi.fn(async () => ({ id: 'dl' })) };
  const service = new ConsoleWebhooksService(
    { withOwnerAccess, withEditorAccess, withAccess } as unknown as ConsoleOrganizationsRepository,
    endpoints as unknown as WebhookEndpointsService,
    deliveries as unknown as WebhookDeliveryService,
  );
  return { service, withOwnerAccess, withEditorAccess, withAccess, endpoints, deliveries };
}

describe('ConsoleWebhooksService', () => {
  it('runs the reads, the test event and a replay inside the Owner-or-Developer check, on its transaction', async () => {
    const { service, withOwnerAccess, withEditorAccess, withAccess, endpoints, deliveries } = setup();
    await service.listEndpoints('user', 'org');
    await service.sendTestEvent('user', 'org', 'ep');
    await service.listDeliveries('user', 'org');
    await service.replayDelivery('user', 'org', 'dl');

    expect(withEditorAccess).toHaveBeenCalledTimes(4);
    for (const call of withEditorAccess.mock.calls) expect(call.slice(0, 2)).toEqual(['user', 'org']);
    expect(withOwnerAccess).not.toHaveBeenCalled();
    // Never `withAccess`, whose writes are the Owner's: a test event and a replay are a Developer's too.
    expect(withAccess).not.toHaveBeenCalled();
    expect(endpoints.list).toHaveBeenCalledWith('org', 'tx');
    expect(endpoints.sendTest).toHaveBeenCalledWith('org', 'ep', 'tx');
    expect(deliveries.list).toHaveBeenCalledWith('org', 'tx');
    expect(deliveries.replay).toHaveBeenCalledWith('org', 'dl', 'tx');
  });

  it('runs registering and every endpoint change inside the Owner check, on its transaction', async () => {
    const { service, withOwnerAccess, withEditorAccess, endpoints } = setup();
    await service.registerEndpoint('user', 'org', { url: 'https://x', description: 'pos' });
    await service.disableEndpoint('user', 'org', 'ep');
    await service.enableEndpoint('user', 'org', 'ep');
    await service.rotateSecret('user', 'org', 'ep');

    expect(withOwnerAccess).toHaveBeenCalledTimes(4);
    for (const call of withOwnerAccess.mock.calls) expect(call.slice(0, 2)).toEqual(['user', 'org']);
    expect(withEditorAccess).not.toHaveBeenCalled();
    expect(endpoints.register).toHaveBeenCalledWith('org', 'https://x', 'pos', 'tx');
    expect(endpoints.disable).toHaveBeenCalledWith('org', 'ep', 'tx');
    expect(endpoints.enable).toHaveBeenCalledWith('org', 'ep', 'tx');
    expect(endpoints.rotateSecret).toHaveBeenCalledWith('org', 'ep', 'tx');
  });

  it('checks the body before the database', () => {
    const { service, withOwnerAccess } = setup();
    for (const body of [null, [], 'x', {}, { url: 7 }, { url: 'https://x', description: 7 }])
      expect(() => service.registerEndpoint('user', 'org', body as never)).toThrow(
        expect.objectContaining({ status: 400 }),
      );
    expect(withOwnerAccess).not.toHaveBeenCalled();
  });

  it('turns a refused check into 403 and passes other failures through', async () => {
    await expect(setup('denied').service.listEndpoints('user', 'org')).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/Only an active Owner or Business Developer/),
    });
    await expect(setup('denied').service.rotateSecret('user', 'org', 'ep')).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/Only an active Owner of an active organization can register/),
    });
    await expect(setup('broken').service.listDeliveries('user', 'org')).rejects.toThrow('database down');
  });
});
