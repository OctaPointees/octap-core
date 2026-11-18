import { describe, expect, it, vi } from 'vitest';
import { ConsoleRefundPolicyService } from '#domain/rewards/console-refund-policy.service.js';
import type { RefundPolicyService } from '#domain/rewards/refund-policy.service.js';
import {
  ConsoleAccessError,
  type ConsoleOrganizationsRepository,
} from '#infra/db/repositories/console-organizations.repository.js';

const request = {
  allowUnused: true,
  allowExpired: false,
  allowRedeemed: false,
  restockUnused: true,
  refundWindowDays: null,
  reason: 'Terms',
};

function setup(access: 'granted' | 'denied' = 'granted') {
  const refuse = () => {
    if (access === 'denied') throw new ConsoleAccessError();
  };
  const organizations = {
    withOwnerAccess: vi.fn(async (_user: string, _org: string, action: (tx: unknown) => unknown) => {
      refuse();
      return action('tx');
    }),
    withAccess: vi.fn(),
    assertOwner: vi.fn(async () => refuse()),
  };
  const policies = {
    current: vi.fn(async () => ({ version: 1 })),
    history: vi.fn(async () => [{ version: 1 }]),
    // Like the repository: the access check runs inside publishing.
    publish: vi.fn(async (_org: string, _user: string, _req: unknown, authorize: (tx: unknown) => Promise<unknown>) => {
      await authorize('tx');
      return { version: 2 };
    }),
  };
  const service = new ConsoleRefundPolicyService(
    organizations as unknown as ConsoleOrganizationsRepository,
    policies as unknown as RefundPolicyService,
  );
  return { service, organizations, policies };
}

describe('ConsoleRefundPolicyService', () => {
  it('reads after the Owner check and publishes as the signed-in Owner, checked on the publishing transaction', async () => {
    const { service, organizations, policies } = setup();
    expect(await service.current('user', 'org')).toEqual({ version: 1 });
    expect(await service.history('user', 'org', { limit: 5 })).toEqual([{ version: 1 }]);
    expect(policies.history).toHaveBeenCalledWith('org', { limit: 5 });
    expect(organizations.withOwnerAccess).toHaveBeenCalledTimes(2);

    expect(await service.publish('user', 'org', request)).toEqual({ version: 2 });
    expect(policies.publish).toHaveBeenCalledWith('org', 'user', request, expect.any(Function));
    expect(organizations.assertOwner).toHaveBeenCalledWith('tx', 'user', 'org');
    expect(organizations.withAccess).not.toHaveBeenCalled();
  });

  it('is a 403 for anyone but the active Owner, reads included', async () => {
    const { service, policies } = setup('denied');
    for (const call of [
      service.current('user', 'org'),
      service.history('user', 'org'),
      service.publish('user', 'org', request),
    ])
      await expect(call).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/Only an active Owner/) });
    expect(policies.current).not.toHaveBeenCalled();
    expect(policies.history).not.toHaveBeenCalled();
  });

  it('passes other failures through', async () => {
    const { service, policies } = setup();
    policies.current.mockRejectedValueOnce(new Error('database down'));
    await expect(service.current('user', 'org')).rejects.toThrow('database down');
  });
});
