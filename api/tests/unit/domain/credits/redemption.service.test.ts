import { describe, expect, it, vi } from 'vitest';
import { RedemptionService } from '../../../../src/domain/credits/redemption.service.js';
import type { CreditsRepository } from '../../../../src/infra/db/repositories/credits.repository.js';
import type { WebhookDeliveryService } from '../../../../src/domain/webhooks/webhook-delivery.service.js';
import { stub } from '../../../helpers/stub.js';
import { buildLoyaltyTransaction } from '../../../helpers/fixtures.js';

const request = { organizationEndUserId: 'user-1', pointsAmount: 30, idempotencyKey: 'idem-redeem-1' };

describe('RedemptionService', () => {
  it('deducts points, emits credits.redeemed, and returns the new balance', async () => {
    const repo = stub<CreditsRepository>({
      findMemberOrganizationId: async () => 'org-1',
      findTransactionByIdempotency: async () => undefined,
      recordRedeemTransaction: async (params: { pointsAmount: number; idempotencyKey: string }) => ({
        transaction: buildLoyaltyTransaction({
          id: 'tx-redeem-1',
          transactionType: 'REDEEM',
          pointsAmount: params.pointsAmount,
          idempotencyKey: params.idempotencyKey,
        }),
        newBalance: 70,
      }),
    });
    const emit = vi.fn(async () => {});
    const service = new RedemptionService(repo, stub<WebhookDeliveryService>({ emit }));

    const result = await service.executeRedeem('org-1', request);

    expect(result).toEqual({
      transactionId: 'tx-redeem-1',
      organizationEndUserId: 'user-1',
      pointsRedeemed: 30,
      newBalance: 70,
      status: 'CONFIRMED',
      idempotencyKey: 'idem-redeem-1',
    });
    expect(emit).toHaveBeenCalledWith('org-1', 'credits.redeemed', {
      transactionId: 'tx-redeem-1',
      organizationEndUserId: 'user-1',
      pointsAmount: 30,
      newBalance: 70,
    });
  });

  it('replays an existing idempotency key with the current balance', async () => {
    const repo = stub<CreditsRepository>({
      findMemberOrganizationId: async () => 'org-1',
      findTransactionByIdempotency: async () =>
        buildLoyaltyTransaction({ id: 'tx-redeem-1', transactionType: 'REDEEM', pointsAmount: 30, idempotencyKey: 'idem-redeem-1' }),
      getOrCreateCreditOwnership: async () => ({ confirmedBalance: 70 }),
      recordRedeemTransaction: () => expect.fail('must not redeem twice'),
    });
    const service = new RedemptionService(repo, stub<WebhookDeliveryService>());

    const result = await service.executeRedeem('org-1', request);

    expect(result).toMatchObject({ transactionId: 'tx-redeem-1', pointsRedeemed: 30, newBalance: 70 });
  });

  it('rejects a non-positive amount', async () => {
    const service = new RedemptionService(stub<CreditsRepository>(), stub<WebhookDeliveryService>());
    await expect(service.executeRedeem('org-1', { ...request, pointsAmount: 0 })).rejects.toThrow(/greater than zero/);
  });

  it('rejects redeeming for a member belonging to another organization', async () => {
    const repo = stub<CreditsRepository>({
      findMemberOrganizationId: async (id: string) => (id === 'user-org1' ? 'org-1' : 'org-2'),
      findTransactionByIdempotency: () => expect.fail('ownership check must happen first'),
    });
    const service = new RedemptionService(repo, stub<WebhookDeliveryService>());

    await expect(
      service.executeRedeem('org-1', { organizationEndUserId: 'user-org2', pointsAmount: 10, idempotencyKey: 'k' }),
    ).rejects.toThrow(/was not found for this organization/);
  });

  it('maps a repository failure (insufficient points) to a 400', async () => {
    const repo = stub<CreditsRepository>({
      findMemberOrganizationId: async () => 'org-1',
      findTransactionByIdempotency: async () => undefined,
      recordRedeemTransaction: async () => {
        throw new Error('Insufficient points: required 30, available 10');
      },
    });
    const service = new RedemptionService(repo, stub<WebhookDeliveryService>());

    await expect(service.executeRedeem('org-1', request)).rejects.toMatchObject({
      name: 'BadRequestException',
      message: 'Insufficient points: required 30, available 10',
    });
  });

  it('falls back to a generic message when a non-Error is thrown', async () => {
    const repo = stub<CreditsRepository>({
      findMemberOrganizationId: async () => 'org-1',
      findTransactionByIdempotency: async () => undefined,
      recordRedeemTransaction: async () => {
        throw 'boom';
      },
    });
    const service = new RedemptionService(repo, stub<WebhookDeliveryService>());

    await expect(service.executeRedeem('org-1', request)).rejects.toThrow('Failed to redeem points');
  });
});
