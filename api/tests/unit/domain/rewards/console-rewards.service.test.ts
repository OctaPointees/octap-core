import { describe, expect, it, vi } from 'vitest';
import { ConsoleRewardsService } from '#domain/rewards/console-rewards.service.js';
import type { RewardsService } from '#domain/rewards/rewards.service.js';
import {
  ConsoleAccessError,
  type ConsoleOrganizationsRepository,
} from '#infra/db/repositories/console-organizations.repository.js';

function setup(access: 'granted' | 'denied' = 'granted', role: 'OWNER' | 'BUSINESS_DEVELOPER' = 'OWNER') {
  const run = vi.fn(async (...args: unknown[]) => {
    if (access === 'denied') throw new ConsoleAccessError();
    return (args.at(-1) as (tx: unknown, role: string) => unknown)('tx', role);
  });
  const organizations = { withAccess: run, withOwnerAccess: run, withEditorAccess: run };
  const rewards = {
    listVouchers: vi.fn(async () => []),
    getVoucher: vi.fn(async () => ({ id: 'v-1' })),
    createVoucher: vi.fn(async () => ({ id: 'v-1' })),
    updateVoucher: vi.fn(async () => ({ id: 'v-1' })),
    submitVoucher: vi.fn(async () => ({ id: 'v-1' })),
    withdrawVoucher: vi.fn(async () => ({ id: 'v-1' })),
    approveVoucher: vi.fn(async () => ({ id: 'v-1' })),
    rejectVoucher: vi.fn(async () => ({ id: 'v-1' })),
  };
  const service = new ConsoleRewardsService(
    organizations as unknown as ConsoleOrganizationsRepository,
    rewards as unknown as RewardsService,
  );
  return { service, organizations, rewards };
}

const voucher = { code: 'C', title: 'T', discountType: 'FREE_ITEM' as const, pointsCost: 100 };
const owner = { role: 'OWNER', userId: 'user' };
const developer = { role: 'DEVELOPER', userId: 'user' };

describe('ConsoleRewardsService', () => {
  it('always creates a DRAFT inside the editor check, and refuses any other status', async () => {
    const { service, organizations, rewards } = setup();
    await service.create('user', 'org', voucher);
    expect(organizations.withEditorAccess).toHaveBeenCalledWith('user', 'org', expect.any(Function));
    expect(rewards.createVoucher).toHaveBeenLastCalledWith('org', { ...voucher, status: 'DRAFT' }, owner, 'tx');
    await service.create('user', 'org', { ...voucher, status: 'DRAFT' });
    expect(rewards.createVoucher).toHaveBeenCalledTimes(2);

    rewards.createVoucher.mockClear();
    organizations.withEditorAccess.mockClear();
    for (const status of ['ACTIVE', 'PAUSED', 'DEPLETED']) {
      expect(() => service.create('user', 'org', { ...voucher, status } as never)).toThrow(
        /created as DRAFT; activate it with PATCH/,
      );
    }
    expect(organizations.withEditorAccess).not.toHaveBeenCalled();
    expect(rewards.createVoucher).not.toHaveBeenCalled();
  });

  it('requires pointsCost, but allows 0, before any access check', async () => {
    const { service, organizations } = setup();
    const withoutCost: Record<string, unknown> = { ...voucher };
    delete withoutCost.pointsCost;
    expect(() => service.create('user', 'org', withoutCost as never)).toThrow(/pointsCost is required/);
    expect(() => service.create('user', 'org', null as never)).toThrow(/must be an object/);
    expect(organizations.withEditorAccess).not.toHaveBeenCalled();
    await expect(service.create('user', 'org', { ...voucher, pointsCost: 0 })).resolves.toEqual({ id: 'v-1' });
  });

  it("passes the caller's role on as the actor: a Business Developer writes as DEVELOPER", async () => {
    const { service, rewards } = setup('granted', 'BUSINESS_DEVELOPER');
    await service.create('user', 'org', voucher);
    expect(rewards.createVoucher).toHaveBeenLastCalledWith('org', { ...voucher, status: 'DRAFT' }, developer, 'tx');
    await service.update('user', 'org', 'v-1', { status: 'ACTIVE' });
    expect(rewards.updateVoucher).toHaveBeenCalledWith('org', 'v-1', { status: 'ACTIVE' }, developer, 'tx');
  });

  it('updates inside the editor check, and reads with Owner or Business Developer access', async () => {
    const { service, organizations, rewards } = setup();
    await service.update('user', 'org', 'v-1', { status: 'PAUSED' });
    expect(rewards.updateVoucher).toHaveBeenCalledWith('org', 'v-1', { status: 'PAUSED' }, owner, 'tx');

    await service.list('user', 'org');
    await service.detail('user', 'org', 'v-1');
    expect(organizations.withAccess).toHaveBeenCalledWith('user', 'org', false, expect.any(Function));
    expect(rewards.listVouchers).toHaveBeenCalledWith('org');
    expect(rewards.getVoucher).toHaveBeenCalledWith('org', 'v-1');
  });

  it('lets a Business Developer submit and withdraw; an Owner activates directly instead of submitting', async () => {
    const bd = setup('granted', 'BUSINESS_DEVELOPER');
    await bd.service.submit('user', 'org', 'v-1');
    expect(bd.rewards.submitVoucher).toHaveBeenCalledWith('org', 'v-1', 'user', 'tx');
    await bd.service.withdraw('user', 'org', 'v-1');
    expect(bd.rewards.withdrawVoucher).toHaveBeenCalledWith('org', 'v-1', 'user', 'tx');

    const own = setup();
    await expect(own.service.submit('user', 'org', 'v-1')).rejects.toThrow(/Owner needs no approval/);
    expect(own.rewards.submitVoucher).not.toHaveBeenCalled();
    await own.service.withdraw('user', 'org', 'v-1');
    expect(own.rewards.withdrawVoucher).toHaveBeenCalledWith('org', 'v-1', 'user', 'tx');
  });

  it('approves and rejects inside the Owner check, the submission the Owner reviewed, and requires a reason to reject', async () => {
    const { service, organizations, rewards } = setup();
    const approvalRequestId = '7b9f5a4e-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
    await service.approve('user', 'org', 'v-1', { approvalRequestId });
    expect(organizations.withOwnerAccess).toHaveBeenCalledWith('user', 'org', expect.any(Function));
    expect(rewards.approveVoucher).toHaveBeenCalledWith('org', 'v-1', 'user', approvalRequestId, 'tx');
    await service.reject('user', 'org', 'v-1', { approvalRequestId, reason: '  Cap too high ' });
    expect(rewards.rejectVoucher).toHaveBeenCalledWith('org', 'v-1', 'user', approvalRequestId, 'Cap too high', 'tx');

    rewards.rejectVoucher.mockClear();
    for (const body of [{}, { reason: '  ' }, { reason: 'x'.repeat(501) }, { reason: 'ok', extra: 1 }, null]) {
      expect(() => service.reject('user', 'org', 'v-1', { approvalRequestId, ...body } as never)).toThrow(
        /rejection reason is required/,
      );
    }
    expect(rewards.rejectVoucher).not.toHaveBeenCalled();
  });

  it('refuses to approve or reject without the reviewed submission', () => {
    const { service, rewards } = setup();
    for (const body of [null, {}, { approvalRequestId: 'not-a-uuid' }, { approvalRequestId: 7 }]) {
      expect(() => service.approve('user', 'org', 'v-1', body as never)).toThrow(/approvalRequestId is required/);
      expect(() => service.reject('user', 'org', 'v-1', { ...(body ?? {}), reason: 'no' } as never)).toThrow(
        /approvalRequestId is required/,
      );
    }
    expect(() =>
      service.approve('user', 'org', 'v-1', {
        approvalRequestId: '7b9f5a4e-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
        x: 1,
      } as never),
    ).toThrow(/Only approvalRequestId/);
    expect(rewards.approveVoucher).not.toHaveBeenCalled();
    expect(rewards.rejectVoucher).not.toHaveBeenCalled();
  });

  it('answers 403 when the access check refuses, and writes nothing', async () => {
    const { service, rewards } = setup('denied');
    await expect(service.create('user', 'org', voucher)).rejects.toMatchObject({
      name: 'ForbiddenException',
      message: expect.stringMatching(/Only an active Owner or Business Developer/),
    });
    await expect(service.update('user', 'org', 'v-1', { status: 'ACTIVE' })).rejects.toThrow(/Only an active Owner/);
    await expect(service.submit('user', 'org', 'v-1')).rejects.toThrow(/Only an active Owner/);
    const approvalRequestId = '7b9f5a4e-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
    await expect(service.approve('user', 'org', 'v-1', { approvalRequestId })).rejects.toThrow(
      /Only an active Owner of an active/,
    );
    await expect(service.reject('user', 'org', 'v-1', { approvalRequestId, reason: 'no' })).rejects.toThrow(
      /approve or reject/,
    );
    await expect(service.list('user', 'org')).rejects.toThrow(/Owner or Business Developer/);
    await expect(service.detail('user', 'org', 'v-1')).rejects.toThrow(/Owner or Business Developer/);
    expect(rewards.createVoucher).not.toHaveBeenCalled();
    expect(rewards.updateVoucher).not.toHaveBeenCalled();
    expect(rewards.approveVoucher).not.toHaveBeenCalled();
  });

  it('lets other errors through unchanged', async () => {
    const { service, rewards } = setup();
    const failure = new Error('db down');
    rewards.updateVoucher.mockRejectedValueOnce(failure);
    await expect(service.update('user', 'org', 'v-1', { title: 'x' })).rejects.toBe(failure);
  });
});
