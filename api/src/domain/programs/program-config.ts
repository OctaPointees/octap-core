import { UnprocessableEntityException } from '@nestjs/common';
import type { OctapProgramConfig } from '@octap/chain';
import type { ProgramsRepository } from '#infra/db/repositories/programs.repository.js';

/**
 * The organization has no `ACTIVE`, sharded `programs` row, so there is no on-chain program to
 * dispatch its earn/redeem against. Never fall back to another program: that would silently
 * write one organization's credits into another organization's program.
 */
export class ProgramNotProvisionedError extends Error {
  constructor(organizationId: string, reason: string) {
    super(`Organization ${organizationId} has no on-chain program provisioned (${reason})`);
    this.name = 'ProgramNotProvisionedError';
  }
}

export type ResolvedProgramConfig = OctapProgramConfig & { earnBps: number };

/**
 * The single per-organization lookup every chain dispatch path (earn, open_account, redeem) goes
 * through. Reads the row `ProgramsService.provisionForOrganization` wrote; throws
 * `ProgramNotProvisionedError` unless provisioning fully completed.
 */
export async function resolveProgramConfig(
  repo: Pick<ProgramsRepository, 'findByOrganization'>,
  organizationId: string,
): Promise<ResolvedProgramConfig> {
  const program = await repo.findByOrganization(organizationId);
  if (!program) {
    throw new ProgramNotProvisionedError(organizationId, 'no programs row');
  }
  if (program.status !== 'ACTIVE') {
    throw new ProgramNotProvisionedError(organizationId, `program is ${program.status}`);
  }
  const { programControlId, policyVersionId, issuerCapId, operationShardIds, budgetShardIds, earnBps } = program;
  if (!programControlId || !policyVersionId || !issuerCapId) {
    throw new ProgramNotProvisionedError(organizationId, 'program row is missing on-chain ids');
  }
  // Rows provisioned before OCT-41 were backfilled with no shards; they can't `earn` and need
  // re-provisioning.
  if (!operationShardIds?.length || operationShardIds.length !== budgetShardIds?.length) {
    throw new ProgramNotProvisionedError(organizationId, 'program has no operation/budget shards');
  }
  return { programControlId, policyVersionId, issuerCapId, operationShardIds, budgetShardIds, earnBps };
}

/**
 * `resolveProgramConfig` for HTTP request paths (earn, POS redeem): an unprovisioned organization
 * is the caller's problem, not a server fault, so it surfaces as **422** before anything is
 * reserved — rather than being accepted and then failing asynchronously.
 */
export async function requireProgramConfig(
  repo: Pick<ProgramsRepository, 'findByOrganization'>,
  organizationId: string,
): Promise<ResolvedProgramConfig> {
  try {
    return await resolveProgramConfig(repo, organizationId);
  } catch (err: unknown) {
    if (err instanceof ProgramNotProvisionedError) {
      throw new UnprocessableEntityException(err.message);
    }
    throw err;
  }
}
