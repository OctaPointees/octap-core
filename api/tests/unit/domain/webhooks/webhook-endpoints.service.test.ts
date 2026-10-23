import { describe, expect, it, vi } from 'vitest';
import { WebhookEndpointsService } from '../../../../src/domain/webhooks/webhook-endpoints.service.js';
import type { WebhooksRepository } from '../../../../src/infra/db/repositories/webhooks.repository.js';
import { stub } from '../../../helpers/stub.js';

type Endpoint = {
  id: string;
  organizationId: string;
  url: string;
  secret: string;
  description?: string;
  status: string;
};

/** Minimal in-memory endpoint store with the repository's tenant-scoped lookup semantics. */
function inMemoryRepo() {
  const store = new Map<string, Endpoint>();
  let nextId = 1;
  return stub<WebhooksRepository>({
    createEndpoint: async (data: Omit<Endpoint, 'id' | 'status'>) => {
      const row = { id: `ep-${nextId++}`, status: 'ACTIVE', createdAt: new Date(), updatedAt: new Date(), ...data };
      store.set(row.id, row);
      return row;
    },
    listEndpoints: async (orgId: string) => [...store.values()].filter((e) => e.organizationId === orgId),
    findEndpointForOrganization: async (orgId: string, id: string) =>
      store.get(id)?.organizationId === orgId ? store.get(id) : undefined,
    setEndpointStatus: async (id: string, status: string) => Object.assign(store.get(id)!, { status }),
    rotateEndpointSecret: async (id: string, secret: string) => Object.assign(store.get(id)!, { secret }),
  });
}

describe('WebhookEndpointsService', () => {
  it('register returns the secret once, list never includes it', async () => {
    const service = new WebhookEndpointsService(inMemoryRepo());

    const registered = await service.register('org-1', 'https://merchant.example/hooks', 'POS integration');
    expect(registered.secret.startsWith('whsec_')).toBe(true);
    expect(registered.description).toBe('POS integration');

    const listed = await service.list('org-1');
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('secret');
    expect(listed[0]).toMatchObject({ id: registered.id, url: 'https://merchant.example/hooks', status: 'ACTIVE' });
    expect(await service.list('org-2')).toEqual([]);
  });

  it.each(['', 'not-a-url', 'ftp://merchant.example'])('rejects an invalid URL (%j)', async (url) => {
    const service = new WebhookEndpointsService(
      stub<WebhooksRepository>({ createEndpoint: () => expect.fail('should not be called') }),
    );
    await expect(service.register('org-1', url)).rejects.toThrow(/valid http/);
  });

  it('disables, re-enables, and rotates the secret of an owned endpoint', async () => {
    const service = new WebhookEndpointsService(inMemoryRepo());
    const { id, secret } = await service.register('org-1', 'http://merchant.example/hooks');

    expect((await service.disable('org-1', id)).status).toBe('DISABLED');
    expect((await service.enable('org-1', id)).status).toBe('ACTIVE');

    const rotated = await service.rotateSecret('org-1', id);
    expect(rotated.secret).not.toBe(secret);
    expect(rotated.secret.startsWith('whsec_')).toBe(true);
  });

  it('rejects managing another organization’s endpoint', async () => {
    const setEndpointStatus = vi.fn();
    const service = new WebhookEndpointsService(
      stub<WebhooksRepository>({
        findEndpointForOrganization: async () => undefined,
        setEndpointStatus,
        rotateEndpointSecret: setEndpointStatus,
      }),
    );

    await expect(service.disable('org-2', 'ep-1')).rejects.toThrow(/was not found/);
    await expect(service.enable('org-2', 'ep-1')).rejects.toThrow(/was not found/);
    await expect(service.rotateSecret('org-2', 'ep-1')).rejects.toThrow(/was not found/);
    expect(setEndpointStatus).not.toHaveBeenCalled();
  });
});
