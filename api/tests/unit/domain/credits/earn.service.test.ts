import { describe, expect, it, vi } from 'vitest';
import { UnprocessableEntityException } from '@nestjs/common';
import { EarnService } from '../../../../src/domain/credits/earn.service.js';
import type { CreditsRepository } from '../../../../src/infra/db/repositories/credits.repository.js';
import type { WebhookDeliveryService } from '../../../../src/domain/webhooks/webhook-delivery.service.js';
import { stub } from '../../../helpers/stub.js';
import { PROGRAMS_REPO, buildLoyaltyTransaction, programsRepoFor } from '../../../helpers/fixtures.js';

const request = { organizationEndUserId: 'user-1', pointsAmount: 50, idempotencyKey: 'idem-1' };

describe('EarnService', () => {
  it('records a new earn, emits credits.earned, and reports the unchanged confirmed balance', async () => {
    const recordEarnTransaction = vi.fn(async (params: { pointsAmount: number; idempotencyKey: string }) => ({
      transaction: buildLoyaltyTransaction({
        id: 'tx-1',
        organizationEndUserId: 'user-1',
        pointsAmount: params.pointsAmount,
        status: 'PENDING',
        idempotencyKey: params.idempotencyKey,
      }),
      newBalance: 150,
    }));
    const repo = stub<CreditsRepository>({
      findMemberOrganizationId: async () => 'org-1',
      findTransactionByIdempotency: async () => undefined,
      recordEarnTransaction,
    });
    const emit = vi.fn(async () => {});
    const service = new EarnService(repo, stub<WebhookDeliveryService>({ emit }), PROGRAMS_REPO);

    const result = await service.executeEarn('org-1', { ...request, receiptReference: 'r-1', metadata: { a: 1 } });

    expect(result).toEqual({
      transactionId: 'tx-1',
      organizationEndUserId: 'user-1',
      pointsEarned: 50,
      newBalance: 150,
      status: 'PENDING',
      idempotencyKey: 'idem-1',
    });
    expect(recordEarnTransaction).toHaveBeenCalledWith({
      organizationId: 'org-1',
      organizationEndUserId: 'user-1',
      pointsAmount: 50,
      idempotencyKey: 'idem-1',
      receiptReference: 'r-1',
      metadata: { a: 1 },
    });
    expect(emit).toHaveBeenCalledWith('org-1', 'credits.earned', {
      transactionId: 'tx-1',
      organizationEndUserId: 'user-1',
      pointsAmount: 50,
      newBalance: 150,
    });
  });

  it('replays an existing idempotency key without recording or emitting again', async () => {
    const repo = stub<CreditsRepository>({
      findMemberOrganizationId: async () => 'org-1',
      findTransactionByIdempotency: async () =>
        buildLoyaltyTransaction({ id: 'tx-1', organizationEndUserId: 'user-1', pointsAmount: 50, idempotencyKey: 'idem-1' }),
      getOrCreateCreditOwnership: async () => ({ confirmedBalance: 150 }),
      recordEarnTransaction: () => expect.fail('must not record twice'),
    });
    const service = new EarnService(repo, stub<WebhookDeliveryService>({ emit: () => expect.fail('must not emit twice') }), PROGRAMS_REPO);

    const result = await service.executeEarn('org-1', request);

    expect(result.transactionId).toBe('tx-1');
    expect(result.newBalance).toBe(150);
    expect(result.status).toBe('CONFIRMED');
  });

  it.each([0, -5])('rejects a non-positive amount (%d) before touching the repository', async (pointsAmount) => {
    const service = new EarnService(stub<CreditsRepository>(), stub<WebhookDeliveryService>(), PROGRAMS_REPO);
    await expect(service.executeEarn('org-1', { ...request, pointsAmount })).rejects.toThrow(/greater than zero/);
  });

  it('rejects earning for a member belonging to another organization', async () => {
    const repo = stub<CreditsRepository>({
      findMemberOrganizationId: async (id: string) => (id === 'user-org1' ? 'org-1' : 'org-2'),
      findTransactionByIdempotency: () => expect.fail('ownership check must happen first'),
    });
    const service = new EarnService(repo, stub<WebhookDeliveryService>(), PROGRAMS_REPO);

    await expect(
      service.executeEarn('org-1', { organizationEndUserId: 'user-org2', pointsAmount: 50, idempotencyKey: 'k' }),
    ).rejects.toThrow(/was not found for this organization/);
  });
});

describe('EarnService per-organization programs (OCT-73)', () => {
  it('rejects with 422 for an organization without a program, reserving nothing', async () => {
    const repo = stub<CreditsRepository>({
      findMemberOrganizationId: async () => 'org-1',
      findTransactionByIdempotency: async () => undefined,
      recordEarnTransaction: () => expect.fail('must not reserve points'),
    });
    const service = new EarnService(repo, stub<WebhookDeliveryService>(), programsRepoFor({}));

    const err = await service.executeEarn('org-1', request).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as Error).message).toMatch(/org-1 has no on-chain program provisioned \(no programs row\)/);
  });
});
