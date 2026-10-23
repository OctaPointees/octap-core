import { describe, expect, it } from 'vitest';
import { UnprocessableEntityException } from '@nestjs/common';
import {
  ProgramNotProvisionedError,
  requireProgramConfig,
  resolveProgramConfig,
} from '../../../../src/domain/programs/program-config.js';
import type { ProgramsRepository } from '../../../../src/infra/db/repositories/programs.repository.js';
import { stub } from '../../../helpers/stub.js';
import { buildProgramRow, programConfigFor, programsRepoFor } from '../../../helpers/fixtures.js';

describe('resolveProgramConfig', () => {
  it("returns the organization row's on-chain ids", async () => {
    await expect(resolveProgramConfig(programsRepoFor({ 'org-1': buildProgramRow('org-1') }), 'org-1')).resolves.toEqual(
      programConfigFor('org-1'),
    );
  });

  it.each([
    ['no row', undefined, /no programs row/],
    ['still provisioning', buildProgramRow('org-1', { status: 'PROVISIONING', programControlId: null }), /program is PROVISIONING/],
    ['missing an on-chain id', buildProgramRow('org-1', { issuerCapId: null }), /missing on-chain ids/],
    ['shardless (pre-OCT-41)', buildProgramRow('org-1', { operationShardIds: null, budgetShardIds: null }), /no operation\/budget shards/],
    ['mismatched shard counts', buildProgramRow('org-1', { budgetShardIds: [] }), /no operation\/budget shards/],
  ])('rejects a program that is %s', async (_label, row, expected) => {
    const err = await resolveProgramConfig(programsRepoFor({ 'org-1': row }), 'org-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProgramNotProvisionedError);
    expect((err as Error).message).toMatch(expected);
  });
});

describe('requireProgramConfig', () => {
  it('maps an unprovisioned organization to 422', async () => {
    await expect(requireProgramConfig(programsRepoFor({}), 'org-1')).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('passes through any other failure unchanged', async () => {
    const boom = new Error('connection refused');
    const repo = stub<ProgramsRepository>({ findByOrganization: async () => { throw boom; } });
    await expect(requireProgramConfig(repo, 'org-1')).rejects.toBe(boom);
  });

  it('returns the config for a provisioned organization', async () => {
    await expect(requireProgramConfig(programsRepoFor({ 'org-1': buildProgramRow('org-1') }), 'org-1')).resolves.toEqual(
      programConfigFor('org-1'),
    );
  });
});
