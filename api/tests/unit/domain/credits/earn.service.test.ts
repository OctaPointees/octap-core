import { describe, expect, it, vi } from 'vitest';
import { EarnService } from '#domain/credits/earn.service.js';
import type { CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import { OperationPayloadConflictError } from '#infra/db/repositories/operations.repository.js';
import type { IssuanceBudgetService } from '#domain/credits/issuance-budget.service.js';
import type { WebhookDeliveryService } from '#domain/webhooks/webhook-delivery.service.js';
import { stub } from '../../../helpers/stub.js';
import { PROGRAMS_REPO, buildLoyaltyTransaction, programsRepoFor } from '../../../helpers/fixtures.js';

const request = { organizationEndUserId: 'user-1', purchaseAmount: 100000, idempotencyKey: 'idem-1' };
const budget = stub<IssuanceBudgetService>({ canCover: async () => true });
function setup(existing?: ReturnType<typeof buildLoyaltyTransaction>) {
  const recordEarnTransaction = vi.fn(
    async (params: { purchaseAmount: number; estimatedPoints: number; idempotencyKey: string }) => ({
      transaction:
        existing ??
        buildLoyaltyTransaction({
          id: 'tx-1',
          organizationEndUserId: 'user-1',
          purchaseAmount: params.purchaseAmount,
          pointsAmount: params.estimatedPoints,
          status: 'PENDING',
          idempotencyKey: params.idempotencyKey,
        }),
      newBalance: 150,
      isNew: !existing,
    }),
  );
  const emit = vi.fn(async () => {});
  const repo = stub<CreditsRepository>({
    findMemberOrganizationId: async () => 'org-1',
    findTransactionByIdempotency: async () => existing,
    recordEarnTransaction,
  });
  return {
    service: new EarnService(repo, stub<WebhookDeliveryService>({ emit }), PROGRAMS_REPO, budget),
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
    const { service, emit } = setup(
      buildLoyaltyTransaction({ purchaseAmount: 100000, pointsAmount: 900, idempotencyKey: 'idem-1' }),
    );
    expect(await service.executeEarn('org-1', request)).toMatchObject({
      pointsEarned: 900,
      estimatedPoints: null,
      purchaseAmount: 100000,
    });
    expect(emit).not.toHaveBeenCalled();
  });
  it('lets a retry through even when the program no longer accepts new earns', async () => {
    const { repo } = setup(buildLoyaltyTransaction({ purchaseAmount: 100000, pointsAmount: 900 }));
    const service = new EarnService(repo, stub<WebhookDeliveryService>(), programsRepoFor({}), budget);
    await expect(service.executeEarn('org-1', request)).resolves.toMatchObject({ pointsEarned: 900 });
  });
  it('maps a changed request under a used key to 409', async () => {
    const { repo, recordEarnTransaction } = setup();
    recordEarnTransaction.mockRejectedValueOnce(new OperationPayloadConflictError('idem-1'));
    const service = new EarnService(repo, stub<WebhookDeliveryService>(), PROGRAMS_REPO, budget);
    await expect(service.executeEarn('org-1', request)).rejects.toMatchObject({ status: 409 });
  });
  it('rejects an earn the budget cannot cover, before reserving anything', async () => {
    const { repo, recordEarnTransaction } = setup();
    const service = new EarnService(
      repo,
      stub<WebhookDeliveryService>(),
      PROGRAMS_REPO,
      stub<IssuanceBudgetService>({ canCover: async () => false }),
    );
    await expect(service.executeEarn('org-1', request)).rejects.toMatchObject({ status: 422 });
    expect(recordEarnTransaction).not.toHaveBeenCalled();
  });
  it('rejects a purchase too small to earn a point, before reserving anything', async () => {
    const { service, recordEarnTransaction } = setup();
    await expect(service.executeEarn('org-1', { ...request, purchaseAmount: 99 })).rejects.toMatchObject({
      status: 400,
    });
    expect(recordEarnTransaction).not.toHaveBeenCalled();
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
      new EarnService(repo, stub<WebhookDeliveryService>(), PROGRAMS_REPO, budget).executeEarn('org-1', request),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('rejects an unprovisioned program before reserving points', async () => {
    const { repo, recordEarnTransaction } = setup();
    await expect(
      new EarnService(repo, stub<WebhookDeliveryService>(), programsRepoFor({}), budget).executeEarn('org-1', request),
    ).rejects.toMatchObject({ status: 422 });
    expect(recordEarnTransaction).not.toHaveBeenCalled();
  });
});
