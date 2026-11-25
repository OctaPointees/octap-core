import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { LedgerEvidenceService } from '#domain/credits/ledger-evidence.service.js';
import type { CreditsService } from '#domain/credits/credits.service.js';
import type { SuiTransactionBuilderClient } from '#infra/clients/sui/sui-transaction-builder.client.js';
import { ConsoleAccessError } from '#infra/db/repositories/console-access.js';
import type { ConsoleOrganizationsRepository } from '#infra/db/repositories/console-organizations.repository.js';
import type { CreditsRepository } from '#infra/db/repositories/credits.repository.js';
import type { ProgramsRepository } from '#infra/db/repositories/programs.repository.js';
import { stub } from '../../../helpers/stub.js';
import { fakeRedis } from '../../../helpers/redis.js';

const ORG = 'org-1';
const MEMBER = 'member-1';

function setup(
  options: {
    ownership?: Record<string, unknown>;
    unsettled?: boolean;
    spendable?: () => Promise<bigint | null>;
    program?: Record<string, unknown> | undefined;
    policy?: () => Promise<unknown>;
    denied?: boolean;
  } = {},
) {
  const creditAccountSpendable = vi.fn(options.spendable ?? (async () => 500n));
  const policyVersionDetails = vi.fn(
    options.policy ??
      (async () => ({
        version: 1n,
        earnBps: 100n,
        expiryMs: 1000n,
        publishedDigest: 'D',
        publishedAtMs: Date.parse('2026-11-01T00:00:00Z'),
      })),
  );
  const creditsRepo = stub<CreditsRepository>({
    findMemberOrganizationId: async () => ORG,
    expireDueBucketsForMember: async () => {},
    releaseAbandonedPosHoldsForMember: async () => {},
    getOrCreateCreditOwnership: async () => ({
      confirmedBalance: 500,
      pendingEarn: 0,
      pendingRedemption: 0,
      suiCreditAccountId: '0xaccount',
      ...options.ownership,
    }),
    hasUnsettledChainWork: async () => options.unsettled ?? false,
  });
  const programsRepo = stub<ProgramsRepository>({
    findByOrganization: async () =>
      'program' in options
        ? options.program
        : {
            id: 'p1',
            status: 'ACTIVE',
            programControlId: '0xcontrol',
            policyVersionId: '0xpolicy',
            earnBps: 100,
            expiryMs: 1000,
            createdAt: new Date('2026-11-01T00:00:00Z'),
          },
  });
  const access = stub<ConsoleOrganizationsRepository>({
    withAccess: vi.fn(async () => {
      if (options.denied) throw new ConsoleAccessError();
    }),
  });
  const service = new LedgerEvidenceService(
    fakeRedis(),
    creditsRepo,
    programsRepo,
    stub<SuiTransactionBuilderClient>({ creditAccountSpendable, policyVersionDetails }),
    access,
    stub<CreditsService>({}),
  );
  return { service, creditAccountSpendable, policyVersionDetails };
}

describe('LedgerEvidenceService: balance reconciliation', () => {
  it('MATCH when the chain holds exactly the recorded balance', async () => {
    const result = await setup().service.reconcile(ORG, MEMBER);
    expect(result).toMatchObject({
      status: 'MATCH',
      creditAccountId: '0xaccount',
      recordedBalance: 500,
      ledgerBalance: 500,
      difference: 0,
    });
  });

  it('MISMATCH when nothing is in flight and they differ', async () => {
    const result = await setup({ spendable: async () => 450n }).service.reconcile(ORG, MEMBER);
    expect(result).toMatchObject({ status: 'MISMATCH', ledgerBalance: 450, difference: -50 });
  });

  it.each([
    ['a pending earn', { ownership: { pendingEarn: 10 } }],
    ['a pending redemption hold', { ownership: { pendingRedemption: 10 } }],
    ['an unsettled chain command', { unsettled: true }],
  ])('PENDING, not MISMATCH, while %s is on its way to the chain', async (_label, options) => {
    const result = await setup({ ...options, spendable: async () => 450n }).service.reconcile(ORG, MEMBER);
    expect(result.status).toBe('PENDING');
  });

  it('compares a member with no CreditAccount yet as 0 on-chain, without reading the chain', async () => {
    const { service, creditAccountSpendable } = setup({ ownership: { suiCreditAccountId: null, confirmedBalance: 0 } });
    expect(await service.reconcile(ORG, MEMBER)).toMatchObject({ status: 'MATCH', ledgerBalance: 0 });
    expect(creditAccountSpendable).not.toHaveBeenCalled();
  });

  it('UNAVAILABLE when the chain cannot be read, and that answer is not cached', async () => {
    const spendable = vi.fn<() => Promise<bigint | null>>();
    spendable.mockRejectedValueOnce(new Error('rpc down')).mockResolvedValueOnce(500n);
    const { service } = setup({ spendable });
    expect(await service.reconcile(ORG, MEMBER)).toMatchObject({ status: 'UNAVAILABLE', ledgerBalance: null });
    expect((await service.reconcile(ORG, MEMBER)).status).toBe('MATCH');
  });

  it('caches a readable answer, so polling does not hit the chain every time', async () => {
    const { service, creditAccountSpendable } = setup();
    await service.reconcile(ORG, MEMBER);
    await service.reconcile(ORG, MEMBER);
    expect(creditAccountSpendable).toHaveBeenCalledOnce();
  });

  it('404s another organization’s member, and 403s someone without console access', async () => {
    const { service } = setup();
    await expect(service.reconcile('org-2', MEMBER)).rejects.toBeInstanceOf(NotFoundException);
    await expect(setup({ denied: true }).service.reconcileAsMember('u', ORG, MEMBER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe('LedgerEvidenceService: program evidence', () => {
  it('MATCH when the frozen on-chain policy holds the rules OctaP applies', async () => {
    const result = await setup().service.program(ORG);
    expect(result).toMatchObject({
      programControlId: '0xcontrol',
      policyStatus: 'MATCH',
      policy: {
        policyVersionId: '0xpolicy',
        version: 1,
        publishedDigest: 'D',
        publishedAt: '2026-11-01T00:00:00.000Z',
      },
    });
  });

  it('MISMATCH when the chain’s rules differ, or the policy object is missing', async () => {
    const differs = await setup({
      policy: async () => ({ version: 1n, earnBps: 200n, expiryMs: 1000n, publishedDigest: 'D', publishedAtMs: null }),
    }).service.program(ORG);
    expect(differs.policyStatus).toBe('MISMATCH');
    expect((await setup({ policy: async () => null }).service.program(ORG)).policyStatus).toBe('MISMATCH');
  });

  it('UNAVAILABLE when the chain cannot be read', async () => {
    const result = await setup({
      policy: async () => {
        throw new Error('rpc down');
      },
    }).service.program(ORG);
    expect(result).toMatchObject({ policyStatus: 'UNAVAILABLE', policy: null });
  });

  it('caches the frozen policy', async () => {
    const { service, policyVersionDetails } = setup();
    await service.program(ORG);
    await service.program(ORG);
    expect(policyVersionDetails).toHaveBeenCalledOnce();
  });

  it('404s an organization without a provisioned program', async () => {
    await expect(setup({ program: undefined }).service.program(ORG)).rejects.toBeInstanceOf(NotFoundException);
  });
});
