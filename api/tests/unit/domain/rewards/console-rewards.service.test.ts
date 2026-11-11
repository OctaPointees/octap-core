import { describe, expect, it, vi } from 'vitest';
import { ConsoleRewardsService } from '#domain/rewards/console-rewards.service.js';
import type { RewardsService } from '#domain/rewards/rewards.service.js';
import {
  ConsoleAccessError,
  type ConsoleOrganizationsRepository,
} from '#infra/db/repositories/console-organizations.repository.js';

function setup(access: 'granted' | 'denied' = 'granted') {
  const run = vi.fn(async (...args: unknown[]) => {
    if (access === 'denied') throw new ConsoleAccessError();
    return (args.at(-1) as (tx: unknown) => unknown)('tx');
  });
  const organizations = { withAccess: run, withOwnerAccess: run };
  const rewards = {
    listVouchers: vi.fn(async () => []),
    getVoucher: vi.fn(async () => ({ id: 'v-1' })),
    createVoucher: vi.fn(async () => ({ id: 'v-1' })),
    updateVoucher: vi.fn(async () => ({ id: 'v-1' })),
  };
  const service = new ConsoleRewardsService(
    organizations as unknown as ConsoleOrganizationsRepository,
    rewards as unknown as RewardsService,
  );
  return { service, organizations, rewards };
}

const voucher = { code: 'C', title: 'T', discountType: 'FREE_ITEM' as const, pointsCost: 100 };

describe('ConsoleRewardsService', () => {
  it('always creates a DRAFT inside the Owner check, and refuses any other status', async () => {
    const { service, organizations, rewards } = setup();
    await service.create('user', 'org', voucher);
    expect(organizations.withOwnerAccess).toHaveBeenCalledWith('user', 'org', expect.any(Function));
    expect(rewards.createVoucher).toHaveBeenLastCalledWith('org', { ...voucher, status: 'DRAFT' }, 'tx');
    await service.create('user', 'org', { ...voucher, status: 'DRAFT' });
    expect(rewards.createVoucher).toHaveBeenCalledTimes(2);

    rewards.createVoucher.mockClear();
    organizations.withOwnerAccess.mockClear();
    for (const status of ['ACTIVE', 'PAUSED', 'DEPLETED']) {
      expect(() => service.create('user', 'org', { ...voucher, status } as never)).toThrow(
        /created as DRAFT; activate it with PATCH/,
      );
    }
    expect(organizations.withOwnerAccess).not.toHaveBeenCalled();
    expect(rewards.createVoucher).not.toHaveBeenCalled();
  });

  it('requires pointsCost, but allows 0, before any access check', async () => {
    const { service, organizations } = setup();
    const withoutCost: Record<string, unknown> = { ...voucher };
    delete withoutCost.pointsCost;
    expect(() => service.create('user', 'org', withoutCost as never)).toThrow(/pointsCost is required/);
    expect(() => service.create('user', 'org', null as never)).toThrow(/must be an object/);
    expect(organizations.withOwnerAccess).not.toHaveBeenCalled();
    await expect(service.create('user', 'org', { ...voucher, pointsCost: 0 })).resolves.toEqual({ id: 'v-1' });
  });

  it('updates inside the Owner check, and reads with Owner or Business Developer access', async () => {
    const { service, organizations, rewards } = setup();
    await service.update('user', 'org', 'v-1', { status: 'PAUSED' });
    expect(rewards.updateVoucher).toHaveBeenCalledWith('org', 'v-1', { status: 'PAUSED' }, 'tx');

    await service.list('user', 'org');
    await service.detail('user', 'org', 'v-1');
    expect(organizations.withAccess).toHaveBeenCalledWith('user', 'org', false, expect.any(Function));
    expect(rewards.listVouchers).toHaveBeenCalledWith('org');
    expect(rewards.getVoucher).toHaveBeenCalledWith('org', 'v-1');
  });

  it('answers 403 when the access check refuses, and writes nothing', async () => {
    const { service, rewards } = setup('denied');
    await expect(service.create('user', 'org', voucher)).rejects.toMatchObject({
      name: 'ForbiddenException',
      message: expect.stringMatching(/Only an active Owner/),
    });
    await expect(service.update('user', 'org', 'v-1', { status: 'ACTIVE' })).rejects.toThrow(/Only an active Owner/);
    await expect(service.list('user', 'org')).rejects.toThrow(/Owner or Business Developer/);
    await expect(service.detail('user', 'org', 'v-1')).rejects.toThrow(/Owner or Business Developer/);
    expect(rewards.createVoucher).not.toHaveBeenCalled();
    expect(rewards.updateVoucher).not.toHaveBeenCalled();
  });

  it('lets other errors through unchanged', async () => {
    const { service, rewards } = setup();
    const failure = new Error('db down');
    rewards.updateVoucher.mockRejectedValueOnce(failure);
    await expect(service.update('user', 'org', 'v-1', { title: 'x' })).rejects.toBe(failure);
  });
});
