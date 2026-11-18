import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { CreditsService } from '#domain/credits/credits.service.js';
import type { CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import type { IndexerRepository } from '#infra/db/repositories/indexer.repository.js';
import { stub } from '../../../helpers/stub.js';
import { PROGRAMS_REPO, buildLoyaltyTransaction } from '../../../helpers/fixtures.js';

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
      releaseAbandonedPosHoldsForMember: async () => 0,
      getOrCreateCreditOwnership: async () => settled,
    });
    const service = new CreditsService(repo, noCursor, PROGRAMS_REPO);

    expect((await service.getBalance('org-1', 'user-org1')).confirmedBalance).toBe(100);
    await expect(service.getBalance('org-1', 'user-org2')).rejects.toThrow(/was not found for this organization/);
  });

  it('carries asOfCheckpoint/observedAt, and stale flips while anything is pending', async () => {
    let ownership = { ...settled };
    const repo = stub<CreditsRepository>({
      findMemberOrganizationId: async () => 'org-1',
      expireDueBucketsForMember: async () => 0,
      releaseAbandonedPosHoldsForMember: async () => 0,
      getOrCreateCreditOwnership: async () => ownership,
    });
    const indexerRepo = stub<IndexerRepository>({
      getCursor: async (stream: string) =>
        stream === 'octap::credit_account' ? { lastCheckpoint: '394761967' } : undefined,
    });
    const service = new CreditsService(repo, indexerRepo, PROGRAMS_REPO);

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
      releaseAbandonedPosHoldsForMember: async () => 0,
      getOrCreateCreditOwnership: async () => settled,
    });

    expect(
      (await new CreditsService(repo, noCursor, PROGRAMS_REPO).getBalance('org-1', 'user-1')).asOfCheckpoint,
    ).toBeNull();
  });

  it('sweeps due buckets before reading the balance (lazy expiry)', async () => {
    const order: unknown[] = [];
    const repo = stub<CreditsRepository>({
      findMemberOrganizationId: async () => 'org-1',
      expireDueBucketsForMember: async (member: unknown) => {
        order.push(['expire', member]);
        return 2500;
      },
      releaseAbandonedPosHoldsForMember: async () => 0,
      getOrCreateCreditOwnership: async () => {
        order.push(['read']);
        return { ...settled, confirmedBalance: 0, lifetimeEarned: 2500 };
      },
    });

    const balance = await new CreditsService(repo, noCursor, PROGRAMS_REPO).getBalance('org-1', 'user-1');

    expect(order).toEqual([['expire', { organizationId: 'org-1', organizationEndUserId: 'user-1' }], ['read']]);
    expect(balance.confirmedBalance).toBe(0);
  });
});

describe('CreditsService.getBalance abandoned POS holds (OCT-244)', () => {
  it('releases the member’s abandoned POS holds before reading the balance', async () => {
    const order: unknown[] = [];
    const repo = stub<CreditsRepository>({
      findMemberOrganizationId: async () => 'org-1',
      expireDueBucketsForMember: async () => 0,
      releaseAbandonedPosHoldsForMember: async (member: unknown) => {
        order.push(['release', member]);
        return 50;
      },
      getOrCreateCreditOwnership: async () => {
        order.push(['read']);
        return settled;
      },
    });

    await new CreditsService(repo, noCursor, PROGRAMS_REPO).getBalance('org-1', 'user-1');

    expect(order).toEqual([['release', { organizationId: 'org-1', organizationEndUserId: 'user-1' }], ['read']]);
  });
});

describe('CreditsService.listTransactions', () => {
  const MEMBER_CURSOR = '00000000-0000-4000-8000-000000000001';
  const service = (repo: CreditsRepository) => new CreditsService(repo, noCursor, PROGRAMS_REPO);

  it('maps rows to DTOs, including the blockchain digest when there is one', async () => {
    const listTransactionPageByMember = vi.fn(async () => ({
      rows: [
        {
          row: buildLoyaltyTransaction({ id: 'tx-1', blockchainTransactionId: 'btx-1', metadata: { a: 1 } }),
          digest: 'DIGEST-1',
        },
        { row: buildLoyaltyTransaction({ id: 'tx-2', transactionType: 'REDEEM' }), digest: null },
      ],
      nextCursor: 'tx-2',
    }));
    const repo = stub<CreditsRepository>({
      findMemberOrganizationId: async () => 'org-1',
      listTransactionPageByMember,
    });

    const result = await service(repo).listTransactions('org-1', 'user-1', { limit: '10', cursor: MEMBER_CURSOR });

    expect(listTransactionPageByMember).toHaveBeenCalledWith('org-1', 'user-1', 10, MEMBER_CURSOR);
    expect(result.nextCursor).toBe('tx-2');
    expect(result.items[0]).toEqual({
      id: 'tx-1',
      organizationId: 'org-1',
      organizationEndUserId: 'user-1',
      createdByMembershipId: null,
      blockchainTransactionId: 'btx-1',
      blockchainDigest: 'DIGEST-1',
      transactionType: 'EARN',
      pointsAmount: 50,
      purchaseAmount: null,
      estimatedPoints: null,
      idempotencyKey: 'earn-1',
      receiptReference: null,
      status: 'CONFIRMED',
      metadata: { a: 1 },
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
    expect(result.items[1].blockchainDigest).toBeNull();
  });

  it('defaults to 25 rows from the newest', async () => {
    const listTransactionPageByMember = vi.fn(async () => ({ rows: [], nextCursor: null }));
    const repo = stub<CreditsRepository>({
      findMemberOrganizationId: async () => 'org-1',
      listTransactionPageByMember,
    });

    expect(await service(repo).listTransactions('org-1', 'user-1')).toEqual({ items: [], nextCursor: null });
    expect(listTransactionPageByMember).toHaveBeenCalledWith('org-1', 'user-1', 25, undefined);
  });

  it('rejects a bad limit or cursor before reading, and a cursor from another member', async () => {
    const repo = stub<CreditsRepository>({
      findMemberOrganizationId: async () => 'org-1',
      listTransactionPageByMember: async () => null,
    });
    for (const query of [{ limit: '0' }, { limit: '101' }, { limit: 'x' }, { cursor: 'bad' }])
      await expect(service(repo).listTransactions('org-1', 'user-1', query)).rejects.toThrow(BadRequestException);
    await expect(service(repo).listTransactions('org-1', 'user-1', { cursor: MEMBER_CURSOR })).rejects.toThrow(
      'Invalid cursor',
    );
  });

  it('rejects a member from another organization', async () => {
    const repo = stub<CreditsRepository>({
      findMemberOrganizationId: async () => 'org-2',
      listTransactionPageByMember: () => expect.fail('membership check must happen first'),
    });

    await expect(service(repo).listTransactions('org-1', 'user-1')).rejects.toThrow(/not found/);
  });
});

describe('CreditsService.getBalance programId', () => {
  const repo = stub<CreditsRepository>({
    findMemberOrganizationId: async () => 'org-1',
    expireDueBucketsForMember: async () => 0,
    releaseAbandonedPosHoldsForMember: async () => 0,
    getOrCreateCreditOwnership: async () => settled,
  });
  const service = new CreditsService(repo, noCursor, PROGRAMS_REPO);

  it.each(['program-org-1', '0xprogram-org-1'])('accepts the organization program %s', async (programId) => {
    expect((await service.getBalance('org-1', 'user-1', programId)).confirmedBalance).toBe(100);
  });

  it('rejects another program instead of ignoring programId', async () => {
    await expect(service.getBalance('org-1', 'user-1', 'another-program')).rejects.toMatchObject({ status: 404 });
  });
});
