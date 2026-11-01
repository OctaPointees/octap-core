import { describe, expect, it, vi } from 'vitest';
import { RefundPolicyService } from '#domain/rewards/refund-policy.service.js';
import {
  RefundPolicyOrganizationNotFoundError,
  VoucherRefundPoliciesRepository,
} from '#infra/db/repositories/voucher-refund-policies.repository.js';
import { stub } from '../../../helpers/stub.js';

describe('RefundPolicyService', () => {
  const policy = {
    allowUnused: true,
    allowExpired: false,
    allowRedeemed: false,
    restockUnused: true,
    refundWindowDays: null as number | null,
  };
  const request = { ...policy, reason: 'Refund terms' };
  it('delegates tenant-scoped reads and validated publication', async () => {
    const current = vi.fn(async () => ({ version: 1 }));
    const history = vi.fn(async () => [{ version: 1 }]);
    const publish = vi.fn(async () => ({ version: 2 }));
    const service = new RefundPolicyService(stub<VoucherRefundPoliciesRepository>({ current, history, publish }));
    expect(await service.current('org')).toEqual({ version: 1 });
    expect(await service.history('org')).toEqual([{ version: 1 }]);
    expect(await service.publish('org', 'credential', request)).toEqual({ version: 2 });
    expect(publish).toHaveBeenCalledWith('org', 'credential', request);
    await expect(service.publish('org', 'credential', { ...request, reason: '' })).rejects.toThrow();
    expect(publish).toHaveBeenCalledTimes(1);
  });
  it('validates bounded history filters before reaching persistence', async () => {
    const history = vi.fn(async () => []);
    const service = new RefundPolicyService(stub<VoucherRefundPoliciesRepository>({ history }));
    await service.history('org', { limit: 100, beforeVersion: 7 });
    expect(history).toHaveBeenCalledWith('org', { limit: 100, beforeVersion: 7 });
    for (const limit of [0, 101, 1.5, NaN])
      await expect(service.history('org', { limit })).rejects.toMatchObject({ status: 400 });
    for (const beforeVersion of [0, -1, 1.5, 2147483648, NaN])
      await expect(service.history('org', { beforeVersion })).rejects.toMatchObject({ status: 400 });
    expect(history).toHaveBeenCalledTimes(1);
  });

  it('maps missing organization/credential errors and preserves unexpected failures', async () => {
    const publish = vi
      .fn()
      .mockRejectedValueOnce(new RefundPolicyOrganizationNotFoundError())
      .mockRejectedValueOnce(new Error('database down'));
    const service = new RefundPolicyService(stub<VoucherRefundPoliciesRepository>({ publish }));
    await expect(service.publish('org', 'credential', request)).rejects.toMatchObject({ status: 404 });
    await expect(service.publish('org', 'credential', request)).rejects.toThrow('database down');
  });
});
