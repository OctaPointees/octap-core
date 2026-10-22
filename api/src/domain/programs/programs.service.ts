import { Injectable, ConflictException, Logger } from '@nestjs/common';
import { ProgramsRepository } from '../../infra/db/repositories/programs.repository.js';
import { ProgramAdminClient, type ProvisionedProgram } from '../../infra/clients/sui/program-admin.client.js';

/** Postgres `unique_violation` — possibly wrapped by drizzle in a `cause`. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | undefined;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

/**
 * Worker-only (see `worker.module.ts`): depends on `ProgramAdminClient`, which holds
 * `SUI_PROGRAM_ADMIN_PRIVATE_KEY`. Not a `domain/domain.module.ts` feature module for the same
 * reason `ChainSubmitProcessor` isn't — that module is also imported by `AppModule`, and this
 * signer must never reach the HTTP process.
 */
@Injectable()
export class ProgramsService {
  private readonly logger = new Logger(ProgramsService.name);

  constructor(
    private readonly repo: ProgramsRepository,
    private readonly admin: ProgramAdminClient,
  ) {}

  /**
   * One-time per-organization on-chain provisioning: creates a program, publishes+activates a
   * policy, and mints an `IssuerCap` for `params.issuerRecipient`.
   *
   * Race-safe by reserving the organization's `programs` row *before* any chain call: the unique
   * index on `organization_id` lets exactly one concurrent caller through, and every other caller
   * gets a `ConflictException` without touching the chain. If provisioning fails on-chain the
   * reservation is released so the organization can retry; if it succeeds but the final DB
   * update fails, the reservation stays `PROVISIONING` (blocking a duplicate mint) and the minted
   * object ids are logged for manual repair.
   */
  async provisionForOrganization(params: {
    organizationId: string;
    earnBps: number;
    expiryMs: number;
    issuerRecipient: string;
  }) {
    let reservation: Awaited<ReturnType<ProgramsRepository['reserve']>>;
    try {
      reservation = await this.repo.reserve({
        organizationId: params.organizationId,
        policyVersion: 1,
        earnBps: params.earnBps,
        expiryMs: params.expiryMs,
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(`Organization ${params.organizationId} already has a program`);
      }
      throw err;
    }

    let provisioned: ProvisionedProgram;
    try {
      provisioned = await this.admin.provisionProgram({
        earnBps: params.earnBps,
        expiryMs: params.expiryMs,
        issuerRecipient: params.issuerRecipient,
      });
    } catch (err: unknown) {
      await this.repo.release(reservation.id);
      throw err;
    }

    try {
      return await this.repo.activate(reservation.id, {
        programControlId: provisioned.programId,
        adminCapId: provisioned.adminCapId,
        policyVersionId: provisioned.policyVersionId,
        issuerCapId: provisioned.issuerCapId,
      });
    } catch (err: unknown) {
      this.logger.error(
        `program ${reservation.id} minted on-chain but not recorded — repair manually: ${JSON.stringify(provisioned)}`,
      );
      throw err;
    }
  }
}
