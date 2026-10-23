import { describe, expect, it, vi } from 'vitest';
import { CreditsService } from '#domain/credits/credits.service.js';
import type { CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import type { IndexerRepository } from '#infra/db/repositories/indexer.repository.js';
import { stub } from '../../../helpers/stub.js';
import { buildLoyaltyTransaction } from '../../../helpers/fixtures.js';

const settled = {
  confirmedBalance: 100,
  pendingEarn: 0,
  pendingRedemption: 0,
  lifetimeEarned: 100,
  lifetimeRedeemed: 0,
};
const noCursor = stub<IndexerRepository>({ getCursor: async () => undefined });

describe('CreditsService.getBalance', () => {
  it('a member from another organization is treated as not found', async () => {
    const repo = stub<CreditsRepository>({
      findMemberOrganizationId: async (id: string) => (id === 'user-org1' ? 'org-1' : 'org-2'),
      expireDueBucketsForMember: async () => 0,
      getOrCreateCreditOwnership: async () => settled,
    });
    const service = new CreditsService(repo, noCursor);

    expect((await service.getBalance('org-1', 'user-org1')).confirmedBalance).toBe(100);
    await expect(service.getBalance('org-1', 'user-org2')).rejects.toThrow(/was not found for this organization/);
  });

  it('carries asOfCheckpoint/observedAt, and stale flips while anything is pending', async () => {
    let ownership = { ...settled };
    const repo = stub<CreditsRepository>({
      findMemberOrganizationId: async () => 'org-1',
      expireDueBucketsForMember: async () => 0,
      getOrCreateCreditOwnership: async () => ownership,
    });
    const indexerRepo = stub<IndexerRepository>({
      getCursor: async (stream: string) =>
        stream === 'octap::credit_account' ? { lastCheckpoint: '394761967' } : undefined,
    });
    const service = new CreditsService(repo, indexerRepo);

    const balance = await service.getBalance('org-1', 'user-1');
    expect(balance).toMatchObject({
      organizationEndUserId: 'user-1',
      confirmedBalance: 100,
      lifetimeEarned: 100,
      lifetimeRedeemed: 0,
      asOfCheckpoint: '394761967',
      stale: false,
    });
    expect(Number.isNaN(Date.parse(balance.observedAt))).toBe(false);

    ownership = { ...ownership, pendingEarn: 25 };
    expect((await service.getBalance('org-1', 'user-1')).stale).toBe(true);

    ownership = { ...ownership, pendingEarn: 0, pendingRedemption: 10 };
    expect((await service.getBalance('org-1', 'user-1')).stale).toBe(true);
  });

  it('reports a null checkpoint before the indexer has run', async () => {
    const repo = stub<CreditsRepository>({
      findMemberOrganizationId: async () => 'org-1',
      expireDueBucketsForMember: async () => 0,
      getOrCreateCreditOwnership: async () => settled,
    });

    expect((await new CreditsService(repo, noCursor).getBalance('org-1', 'user-1')).asOfCheckpoint).toBeNull();
  });

  it('sweeps due buckets before reading the balance (lazy expiry)', async () => {
    const order: unknown[] = [];
    const repo = stub<CreditsRepository>({
      findMemberOrganizationId: async () => 'org-1',
      expireDueBucketsForMember: async (member: unknown) => {
        order.push(['expire', member]);
        return 2500;
      },
      getOrCreateCreditOwnership: async () => {
        order.push(['read']);
        return { ...settled, confirmedBalance: 0, lifetimeEarned: 2500 };
      },
    });

    const balance = await new CreditsService(repo, noCursor).getBalance('org-1', 'user-1');

    expect(order).toEqual([['expire', { organizationId: 'org-1', organizationEndUserId: 'user-1' }], ['read']]);
    expect(balance.confirmedBalance).toBe(0);
  });
});

describe('CreditsService.listTransactions', () => {
  it('maps rows to DTOs, including the blockchain digest when there is one', async () => {
    const listTransactionsByMember = vi.fn(async () => [
      {
        ...buildLoyaltyTransaction({ id: 'tx-1', blockchainTransactionId: 'btx-1', metadata: { a: 1 } }),
        blockchainTransaction: { digest: 'DIGEST-1' },
      },
      { ...buildLoyaltyTransaction({ id: 'tx-2', transactionType: 'REDEEM' }), blockchainTransaction: null },
    ]);
    const repo = stub<CreditsRepository>({ findMemberOrganizationId: async () => 'org-1', listTransactionsByMember });

    const result = await new CreditsService(repo, noCursor).listTransactions('org-1', 'user-1', 10);

    expect(listTransactionsByMember).toHaveBeenCalledWith('org-1', 'user-1', 10);
    expect(result[0]).toEqual({
      id: 'tx-1',
      organizationId: 'org-1',
      organizationEndUserId: 'user-1',
      createdByMembershipId: null,
      blockchainTransactionId: 'btx-1',
      blockchainDigest: 'DIGEST-1',
      transactionType: 'EARN',
      pointsAmount: 50,
      idempotencyKey: 'earn-1',
      receiptReference: null,
      status: 'CONFIRMED',
      metadata: { a: 1 },
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
    expect(result[1].blockchainDigest).toBeNull();
  });

  it('defaults to 50 rows', async () => {
    const listTransactionsByMember = vi.fn(async () => []);
    const repo = stub<CreditsRepository>({ findMemberOrganizationId: async () => 'org-1', listTransactionsByMember });

    await new CreditsService(repo, noCursor).listTransactions('org-1', 'user-1');

    expect(listTransactionsByMember).toHaveBeenCalledWith('org-1', 'user-1', 50);
  });

  it('rejects a member from another organization', async () => {
    const repo = stub<CreditsRepository>({
      findMemberOrganizationId: async () => 'org-2',
      listTransactionsByMember: () => expect.fail('membership check must happen first'),
    });

    await expect(new CreditsService(repo, noCursor).listTransactions('org-1', 'user-1')).rejects.toThrow(/not found/);
  });
});
