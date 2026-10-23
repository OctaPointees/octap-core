import { describe, expect, it, vi } from 'vitest';
import { WebhookDeliveryService } from '../../../../src/domain/webhooks/webhook-delivery.service.js';
import type { WebhooksRepository } from '../../../../src/infra/db/repositories/webhooks.repository.js';
import { stub } from '../../../helpers/stub.js';

describe('WebhookDeliveryService.emit', () => {
  it('enqueues one delivery per ACTIVE endpoint', async () => {
    const enqueueDelivery = vi.fn(async () => ({}));
    const service = new WebhookDeliveryService(
      stub<WebhooksRepository>({ listActiveEndpoints: async () => [{ id: 'ep-1' }, { id: 'ep-2' }], enqueueDelivery }),
    );

    await service.emit('org-1', 'credits.earned', { transactionId: 'tx-1' });

    expect(enqueueDelivery.mock.calls).toEqual([
      [
        {
          organizationId: 'org-1',
          endpointId: 'ep-1',
          eventType: 'credits.earned',
          payload: { transactionId: 'tx-1' },
        },
      ],
      [
        {
          organizationId: 'org-1',
          endpointId: 'ep-2',
          eventType: 'credits.earned',
          payload: { transactionId: 'tx-1' },
        },
      ],
    ]);
  });

  it.each([new Error('db down'), 'db down'])(
    'never throws, so webhook infra can’t fail the business operation (%s)',
    async (failure) => {
      const service = new WebhookDeliveryService(
        stub<WebhooksRepository>({
          listActiveEndpoints: async () => {
            throw failure;
          },
        }),
      );
      await expect(service.emit('org-1', 'credits.earned', {})).resolves.toBeUndefined();
    },
  );
});

describe('WebhookDeliveryService.list / replay', () => {
  it('lists the organization’s deliveries', async () => {
    const listDeliveries = vi.fn(async () => [{ id: 'dlv-1' }]);
    const service = new WebhookDeliveryService(stub<WebhooksRepository>({ listDeliveries }));

    expect(await service.list('org-1')).toEqual([{ id: 'dlv-1' }]);
    expect(listDeliveries).toHaveBeenCalledWith('org-1');
  });

  it('replay only works on a DEAD_LETTER delivery of the same org, and keeps its id', async () => {
    const deadLetter = { id: 'dlv-1', organizationId: 'org-1', status: 'DEAD_LETTER' };
    const service = new WebhookDeliveryService(
      stub<WebhooksRepository>({
        findDeliveryForOrganization: async (orgId: string, id: string) =>
          orgId === 'org-1' && id === 'dlv-1' ? deadLetter : undefined,
        resetForReplay: async (id: string) => ({ id, status: 'PENDING', attemptCount: 0 }),
      }),
    );

    expect(await service.replay('org-1', 'dlv-1')).toEqual({ id: 'dlv-1', status: 'PENDING', attemptCount: 0 });
    await expect(service.replay('org-2', 'dlv-1')).rejects.toThrow(/was not found/);
  });

  it('refuses to replay a delivery that is not dead-lettered', async () => {
    const service = new WebhookDeliveryService(
      stub<WebhooksRepository>({
        findDeliveryForOrganization: async () => ({ id: 'dlv-2', organizationId: 'org-1', status: 'PENDING' }),
      }),
    );
    await expect(service.replay('org-1', 'dlv-2')).rejects.toThrow(
      /Only a DEAD_LETTER delivery can be replayed \(current status: PENDING\)/,
    );
  });
});
