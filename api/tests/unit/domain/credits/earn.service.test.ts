import { describe, expect, it, vi } from 'vitest';
import { EarnService } from '#domain/credits/earn.service.js';
import type { CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import type { WebhookDeliveryService } from '#domain/webhooks/webhook-delivery.service.js';
import { stub } from '../../../helpers/stub.js';
import { PROGRAMS_REPO, buildLoyaltyTransaction, programsRepoFor } from '../../../helpers/fixtures.js';

const request = { organizationEndUserId: 'user-1', purchaseAmount: 100000, idempotencyKey: 'idem-1' };
function setup(existing?: ReturnType<typeof buildLoyaltyTransaction>) {
  const recordEarnTransaction = vi.fn(
    async (params: { purchaseAmount: number; estimatedPoints: number; idempotencyKey: string }) => ({
      transaction: buildLoyaltyTransaction({
        id: 'tx-1',
        organizationEndUserId: 'user-1',
        purchaseAmount: params.purchaseAmount,
        pointsAmount: params.estimatedPoints,
        status: 'PENDING',
        idempotencyKey: params.idempotencyKey,
      }),
      newBalance: 150,
    }),
  );
  const emit = vi.fn(async () => {});
  const repo = stub<CreditsRepository>({
    findMemberOrganizationId: async () => 'org-1',
    findTransactionByIdempotency: async () => existing,
    getOrCreateCreditOwnership: async () => ({ confirmedBalance: 150 }),
    recordEarnTransaction,
  });
  return {
    service: new EarnService(repo, stub<WebhookDeliveryService>({ emit }), PROGRAMS_REPO),
    repo,
    emit,
    recordEarnTransaction,
  };
}
describe('EarnService', () => {
  it('reports a 100000 purchase as 1000 estimated points, never as confirmed points', async () => {
    const { service, emit, recordEarnTransaction } = setup();
    expect(await service.executeEarn('org-1', request)).toEqual({
      transactionId: 'tx-1',
      organizationEndUserId: 'user-1',
      purchaseAmount: 100000,
      estimatedPoints: 1000,
      pointsEarned: null,
      newBalance: 150,
      status: 'PENDING',
      idempotencyKey: 'idem-1',
    });
    expect(recordEarnTransaction).toHaveBeenCalledWith({
      ...request,
      organizationId: 'org-1',
      estimatedPoints: 1000,
      receiptReference: undefined,
      metadata: undefined,
    });
    expect(emit).toHaveBeenCalledWith('org-1', 'credits.earned', {
      transactionId: 'tx-1',
      organizationEndUserId: 'user-1',
      purchaseAmount: 100000,
      estimatedPoints: 1000,
      newBalance: 150,
    });
  });
  it('rounds down using integer arithmetic', async () => {
    expect((await setup().service.executeEarn('org-1', { ...request, purchaseAmount: 199 })).estimatedPoints).toBe(1);
  });
  it('replays confirmed state with the actual chain points and no second event', async () => {
    const { service, emit, recordEarnTransaction } = setup(
      buildLoyaltyTransaction({ purchaseAmount: 100000, pointsAmount: 900, idempotencyKey: 'idem-1' }),
    );
    expect(await service.executeEarn('org-1', request)).toMatchObject({
      pointsEarned: 900,
      estimatedPoints: null,
      purchaseAmount: 100000,
    });
    expect(emit).not.toHaveBeenCalled();
    expect(recordEarnTransaction).not.toHaveBeenCalled();
  });
  it.each([{ purchaseAmount: 999 }, { transactionType: 'REDEEM' as const }, { organizationEndUserId: 'other' }])(
    'rejects a reused key with different intent %j',
    async (overrides) => {
      const { service } = setup(buildLoyaltyTransaction({ purchaseAmount: 100000, ...overrides }));
      await expect(service.executeEarn('org-1', request)).rejects.toMatchObject({ status: 409 });
    },
  );
  it('compares metadata without depending on object key order', async () => {
    const { service } = setup(buildLoyaltyTransaction({ purchaseAmount: 100000, metadata: { a: 1, b: 2 } }));
    await expect(service.executeEarn('org-1', { ...request, metadata: { b: 2, a: 1 } })).resolves.toMatchObject({
      status: 'CONFIRMED',
    });
  });
  it.each([0, -5, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid purchase %s',
    async (purchaseAmount) => {
      await expect(setup().service.executeEarn('org-1', { ...request, purchaseAmount })).rejects.toMatchObject({
        status: 400,
      });
    },
  );
  it('rejects a foreign member', async () => {
    const { repo } = setup();
    repo.findMemberOrganizationId = async () => 'org-2';
    await expect(
      new EarnService(repo, stub<WebhookDeliveryService>(), PROGRAMS_REPO).executeEarn('org-1', request),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('rejects an unprovisioned program before reserving points', async () => {
    const { repo, recordEarnTransaction } = setup();
    await expect(
      new EarnService(repo, stub<WebhookDeliveryService>(), programsRepoFor({})).executeEarn('org-1', request),
    ).rejects.toMatchObject({ status: 422 });
    expect(recordEarnTransaction).not.toHaveBeenCalled();
  });
});
