import { Injectable, ConflictException } from '@nestjs/common';
import { ProgramsRepository } from '../../infra/db/repositories/programs.repository.js';
import { ProgramAdminClient } from '../../infra/clients/sui/program-admin.client.js';

/**
 * Worker-only (see `worker.module.ts`): depends on `ProgramAdminClient`, which holds
 * `SUI_PROGRAM_ADMIN_PRIVATE_KEY`. Not a `domain/domain.module.ts` feature module for the same
 * reason `ChainSubmitProcessor` isn't — that module is also imported by `AppModule`, and this
 * signer must never reach the HTTP process.
 */
@Injectable()
export class ProgramsService {
  constructor(
    private readonly repo: ProgramsRepository,
    private readonly admin: ProgramAdminClient,
  ) {}

  /**
   * One-time per-organization on-chain provisioning: creates a program, publishes+activates a
   * policy, and mints an `IssuerCap` for `params.issuerRecipient`. Idempotent at the Postgres
   * level — a second call for an organization that already has a program rejects rather than
   * minting a duplicate program on-chain.
   */
  async provisionForOrganization(params: {
    organizationId: string;
    earnBps: number;
    expiryMs: number;
    issuerRecipient: string;
  }) {
    const existing = await this.repo.findByOrganization(params.organizationId);
    if (existing) {
      throw new ConflictException(
        `Organization ${params.organizationId} already has a program (${existing.programControlId})`,
      );
    }

    const provisioned = await this.admin.provisionProgram({
      earnBps: params.earnBps,
      expiryMs: params.expiryMs,
      issuerRecipient: params.issuerRecipient,
    });

    return this.repo.create({
      organizationId: params.organizationId,
      programControlId: provisioned.programId,
      adminCapId: provisioned.adminCapId,
      policyVersionId: provisioned.policyVersionId,
      issuerCapId: provisioned.issuerCapId,
      policyVersion: 1,
      earnBps: params.earnBps,
      expiryMs: params.expiryMs,
    });
  }
}
