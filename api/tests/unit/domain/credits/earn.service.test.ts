import { describe, expect, it, vi } from 'vitest';
import { EarnService, pointsForPurchase } from '#domain/credits/earn.service.js';
import type { CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import { OperationPayloadConflictError } from '#infra/db/repositories/operations.repository.js';
import type { IssuanceBudgetService } from '#domain/credits/issuance-budget.service.js';
import type { CampaignsRepository } from '#infra/db/repositories/campaigns.repository.js';
import { stub } from '../../../helpers/stub.js';
import { PROGRAMS_REPO, buildLoyaltyTransaction, programsRepoFor } from '../../../helpers/fixtures.js';

const request = { organizationEndUserId: 'user-1', purchaseAmount: 100000, idempotencyKey: 'idem-1' };
const budget = stub<IssuanceBudgetService>({ canCover: async () => true });
const NO_CAMPAIGNS = stub<CampaignsRepository>({ find: async () => undefined });
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
  const repo = stub<CreditsRepository>({
    findMemberOrganizationId: async () => 'org-1',
    findTransactionByIdempotency: async () => existing,
    recordEarnTransaction,
  });
  return {
    service: new EarnService(repo, PROGRAMS_REPO, budget, NO_CAMPAIGNS),
    repo,
    recordEarnTransaction,
  };
}
describe('EarnService', () => {
  it('reports a 100000 purchase as 1000 estimated points, never as confirmed points', async () => {
    const { service, recordEarnTransaction } = setup();
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
      campaignId: undefined,
      multiplierBps: 10_000,
    });
  });
  it('rounds down using integer arithmetic', async () => {
    expect((await setup().service.executeEarn('org-1', { ...request, purchaseAmount: 199 })).estimatedPoints).toBe(1);
  });
  it('replays confirmed state with the actual chain points', async () => {
    const { service } = setup(
      buildLoyaltyTransaction({ purchaseAmount: 100000, pointsAmount: 900, idempotencyKey: 'idem-1' }),
    );
    expect(await service.executeEarn('org-1', request)).toMatchObject({
      pointsEarned: 900,
      estimatedPoints: null,
      purchaseAmount: 100000,
    });
  });
  it('lets a retry through even when the program no longer accepts new earns', async () => {
    const { repo } = setup(buildLoyaltyTransaction({ purchaseAmount: 100000, pointsAmount: 900 }));
    const service = new EarnService(repo, programsRepoFor({}), budget, NO_CAMPAIGNS);
    await expect(service.executeEarn('org-1', request)).resolves.toMatchObject({ pointsEarned: 900 });
  });
  it('maps a changed request under a used key to 409', async () => {
    const { repo, recordEarnTransaction } = setup();
    recordEarnTransaction.mockRejectedValueOnce(new OperationPayloadConflictError('idem-1'));
    const service = new EarnService(repo, PROGRAMS_REPO, budget, NO_CAMPAIGNS);
    await expect(service.executeEarn('org-1', request)).rejects.toMatchObject({ status: 409 });
  });
  it('rejects an earn the budget cannot cover, before reserving anything', async () => {
    const { repo, recordEarnTransaction } = setup();
    const service = new EarnService(
      repo,
      PROGRAMS_REPO,
      stub<IssuanceBudgetService>({ canCover: async () => false }),
      NO_CAMPAIGNS,
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
      new EarnService(repo, PROGRAMS_REPO, budget, NO_CAMPAIGNS).executeEarn('org-1', request),
    ).rejects.toMatchObject({
      status: 404,
    });
  });
  it('rejects an unprovisioned program before reserving points', async () => {
    const { repo, recordEarnTransaction } = setup();
    await expect(
      new EarnService(repo, programsRepoFor({}), budget, NO_CAMPAIGNS).executeEarn('org-1', request),
    ).rejects.toMatchObject({ status: 422 });
    expect(recordEarnTransaction).not.toHaveBeenCalled();
  });
});

describe('EarnService campaigns (OCT-340)', () => {
  const CAMPAIGN_ID = '7f1c2a4e-0b3d-4c5e-8f6a-1b2c3d4e5f60';
  const NOW = Date.now();
  const campaign = (overrides: Record<string, unknown> = {}) => ({
    id: CAMPAIGN_ID,
    organizationId: 'org-1',
    status: 'ACTIVE',
    startsAt: new Date(NOW - 60_000),
    endsAt: new Date(NOW + 60_000),
    multiplierBps: 20_000,
    ...overrides,
  });
  const withCampaign = (row: unknown, locked: unknown = row) => {
    const recordEarnTransaction = vi.fn(
      async (params: {
        estimatedPoints: number;
        idempotencyKey: string;
        campaignGate?: (tx: never) => Promise<unknown>;
      }) => {
        // As the repository does, inside the earn's transaction.
        await params.campaignGate?.('tx' as never);
        return {
          transaction: buildLoyaltyTransaction({
            id: 'tx-1',
            organizationEndUserId: 'user-1',
            pointsAmount: params.estimatedPoints,
            status: 'PENDING',
            idempotencyKey: params.idempotencyKey,
          }),
          newBalance: 0,
          isNew: true,
        };
      },
    );
    const find = vi.fn(async () => row);
    const findLocked = vi.fn(async () => locked);
    const repo = stub<CreditsRepository>({
      findMemberOrganizationId: async () => 'org-1',
      findTransactionByIdempotency: async () => undefined,
      recordEarnTransaction,
    });
    return {
      service: new EarnService(repo, PROGRAMS_REPO, budget, stub<CampaignsRepository>({ find, findLocked })),
      recordEarnTransaction,
      find,
      findLocked,
    };
  };

  it('boosts the estimate by the multiplier and records the campaign and multiplier for the chain', async () => {
    const { service, recordEarnTransaction, find } = withCampaign(campaign());
    const response = await service.executeEarn('org-1', { ...request, campaignId: CAMPAIGN_ID });
    // 100000 at 100 bps is 1000; at 2x, 2000.
    expect(response.estimatedPoints).toBe(2000);
    expect(find).toHaveBeenCalledWith('org-1', CAMPAIGN_ID);
    expect(recordEarnTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN_ID, multiplierBps: 20_000, estimatedPoints: 2000 }),
    );
  });

  it('checks the campaign again under its lock inside the earn, refusing one paused in between', async () => {
    const { service, findLocked } = withCampaign(campaign(), campaign({ status: 'PAUSED' }));
    await expect(service.executeEarn('org-1', { ...request, campaignId: CAMPAIGN_ID })).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(/is PAUSED, not ACTIVE/),
    });
    expect(findLocked).toHaveBeenCalledWith('tx', 'org-1', CAMPAIGN_ID);
  });

  it('is an ordinary 1x earn without a campaignId, never reading campaigns', async () => {
    const { service, recordEarnTransaction, find, findLocked } = withCampaign(campaign());
    await service.executeEarn('org-1', request);
    expect(find).not.toHaveBeenCalled();
    expect(findLocked).not.toHaveBeenCalled();
    expect(recordEarnTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: undefined, multiplierBps: 10_000, estimatedPoints: 1000 }),
    );
  });

  it.each([
    ['another organization (not found)', undefined, /not found for this organization/],
    ['a DRAFT', campaign({ status: 'DRAFT' }), /is DRAFT, not ACTIVE/],
    ['a PAUSED', campaign({ status: 'PAUSED' }), /is PAUSED, not ACTIVE/],
    ['one not started', campaign({ startsAt: new Date(NOW + 60_000), endsAt: new Date(NOW + 120_000) }), /starts at/],
    ['one already over', campaign({ startsAt: new Date(NOW - 120_000), endsAt: new Date(NOW - 60_000) }), /ended at/],
    ['a vouchers-only one', campaign({ multiplierBps: null }), /boosts no earn/],
  ])('refuses %s with a 422, never falling back to the base rate', async (_label, row, message) => {
    const { service, recordEarnTransaction } = withCampaign(row);
    await expect(service.executeEarn('org-1', { ...request, campaignId: CAMPAIGN_ID })).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(message),
    });
    expect(recordEarnTransaction).not.toHaveBeenCalled();
  });

  it('rejects a campaignId that is not an id with a 400', async () => {
    const { service } = withCampaign(campaign());
    await expect(service.executeEarn('org-1', { ...request, campaignId: 'weekend' })).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('pointsForPurchase multiplier', () => {
  it('floors once over purchase x rate x multiplier, as credit_account::earn does', () => {
    // 150 * 1% * 2.5x = 3.75 -> 3 (not floor(1.5) * 2.5 = 2).
    expect(pointsForPurchase(150, 100, 25_000)).toBe(3);
    expect(pointsForPurchase(10_000, 100, 100_000)).toBe(1000);
    expect(pointsForPurchase(10_000, 100)).toBe(100);
  });
});
