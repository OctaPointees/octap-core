import { describe, expect, it, vi } from 'vitest';
import { ProgramsService } from '#domain/programs/programs.service.js';
import type { ProgramsRepository } from '#infra/db/repositories/programs.repository.js';
import type { ProgramAdminClient } from '#infra/clients/sui/program-admin.client.js';
import { stub } from '../../../helpers/stub.js';

const PROVISION_PARAMS = {
  organizationId: 'org-1',
  earnBps: 100,
  expiryMs: 2_592_000_000,
  issuerRecipient: '0xissuer',
  shardCount: 2,
  totalBudget: 1_000_000,
};

const PROVISIONED = {
  programId: '0xprogram',
  adminCapId: '0xadmincap',
  policyVersionId: '0xpolicy',
  issuerCapId: '0xissuercap',
  operationShardIds: ['0xop0', '0xop1'],
  budgetShardIds: ['0xbudget0', '0xbudget1'],
};

const uniqueViolation = () => Object.assign(new Error('Failed query'), { cause: { code: '23505' } });

describe('ProgramsService.provisionForOrganization', () => {
  it('reserves the organization before minting, then activates the row with the on-chain ids', async () => {
    const calls: string[] = [];
    const reserve = vi.fn(async (params: object) => {
      calls.push('reserve');
      return { id: 'program-row-1', ...params, status: 'PROVISIONING' };
    });
    const provisionProgram = vi.fn(async () => {
      calls.push('provisionProgram');
      return PROVISIONED;
    });
    const activate = vi.fn(async (id: string, chainIds: object) => {
      calls.push('activate');
      return { id, status: 'ACTIVE', ...chainIds };
    });

    const result = await new ProgramsService(
      stub<ProgramsRepository>({ reserve, activate }),
      stub<ProgramAdminClient>({ provisionProgram }),
    ).provisionForOrganization(PROVISION_PARAMS);

    expect(calls).toEqual(['reserve', 'provisionProgram', 'activate']);
    expect(reserve).toHaveBeenCalledWith({
      organizationId: 'org-1',
      policyVersion: 1,
      earnBps: 100,
      expiryMs: 2_592_000_000,
      shardCount: 2,
      totalBudget: 1_000_000,
    });
    expect(provisionProgram).toHaveBeenCalledWith({
      earnBps: 100,
      expiryMs: 2_592_000_000,
      issuerRecipient: '0xissuer',
      shardCount: 2,
      totalBudget: 1_000_000,
    });
    expect(activate).toHaveBeenCalledWith('program-row-1', {
      programControlId: '0xprogram',
      adminCapId: '0xadmincap',
      policyVersionId: '0xpolicy',
      issuerCapId: '0xissuercap',
      operationShardIds: ['0xop0', '0xop1'],
      budgetShardIds: ['0xbudget0', '0xbudget1'],
    });
    expect(result).toMatchObject({ status: 'ACTIVE', programControlId: '0xprogram' });
  });

  it.each([
    ['drizzle-wrapped', uniqueViolation()],
    ['raw postgres-js', Object.assign(new Error('duplicate key'), { code: '23505' })],
  ])('a losing concurrent reservation (%s) is a ConflictException and never touches the chain', async (_label, err) => {
    const provisionProgram = vi.fn();
    const provision = new ProgramsService(
      stub<ProgramsRepository>({
        reserve: async () => {
          throw err;
        },
      }),
      stub<ProgramAdminClient>({ provisionProgram }),
    ).provisionForOrganization(PROVISION_PARAMS);

    await expect(provision).rejects.toMatchObject({
      name: 'ConflictException',
      message: expect.stringMatching(/already has a program/),
    });
    expect(provisionProgram).not.toHaveBeenCalled();
  });

  it('a non-unique reservation failure is rethrown as-is, not mapped to a conflict', async () => {
    const provision = new ProgramsService(
      stub<ProgramsRepository>({
        reserve: async () => {
          throw new Error('connection reset');
        },
      }),
      stub<ProgramAdminClient>(),
    ).provisionForOrganization(PROVISION_PARAMS);

    await expect(provision).rejects.toThrow('connection reset');
  });

  it('an on-chain failure releases the reservation so the organization can retry', async () => {
    const release = vi.fn(async () => {});
    const provision = new ProgramsService(
      stub<ProgramsRepository>({ reserve: async (params: object) => ({ id: 'program-row-1', ...params }), release }),
      stub<ProgramAdminClient>({
        provisionProgram: async () => {
          throw new Error('create_program failed on-chain');
        },
      }),
    ).provisionForOrganization(PROVISION_PARAMS);

    await expect(provision).rejects.toThrow(/create_program failed/);
    expect(release).toHaveBeenCalledWith('program-row-1');
  });

  it('a DB failure after minting keeps the reservation, blocking a duplicate mint', async () => {
    const release = vi.fn();
    const provision = new ProgramsService(
      stub<ProgramsRepository>({
        reserve: async (params: object) => ({ id: 'program-row-1', ...params }),
        activate: async () => {
          throw new Error('connection reset');
        },
        release,
      }),
      stub<ProgramAdminClient>({ provisionProgram: async () => PROVISIONED }),
    ).provisionForOrganization(PROVISION_PARAMS);

    await expect(provision).rejects.toThrow('connection reset');
    expect(release).not.toHaveBeenCalled();
  });
});
