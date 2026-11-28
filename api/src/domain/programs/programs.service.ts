import { Injectable, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { ProgramsRepository } from '#infra/db/repositories/programs.repository.js';
import {
  ProgramAdminClient,
  type BudgetShardTopUp,
  type ProvisionedProgram,
} from '#infra/clients/sui/program-admin.client.js';

/** Postgres `unique_violation` — possibly wrapped by drizzle in a `cause`. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | undefined;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

/**
 * Worker-only (see `worker.module.ts`): depends on `ProgramAdminClient`, which signs with the
 * program admin key. Not a `domain/domain.module.ts` feature module for the same
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
   * policy, mints an `IssuerCap` for `params.issuerRecipient`, and creates `params.shardCount`
   * operation/budget shard pairs splitting `params.totalBudget`.
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
    shardCount: number;
    totalBudget: number;
  }) {
    let reservation: Awaited<ReturnType<ProgramsRepository['reserve']>>;
    try {
      reservation = await this.repo.reserve({
        organizationId: params.organizationId,
        policyVersion: 1,
        earnBps: params.earnBps,
        expiryMs: params.expiryMs,
        shardCount: params.shardCount,
        totalBudget: params.totalBudget,
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
        shardCount: params.shardCount,
        totalBudget: params.totalBudget,
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
        operationShardIds: provisioned.operationShardIds,
        budgetShardIds: provisioned.budgetShardIds,
      });
    } catch (err: unknown) {
      this.logger.error(
        `program ${reservation.id} minted on-chain but not recorded — repair manually: ${JSON.stringify(provisioned)}`,
      );
      throw err;
    }
  }

  /**
   * Replaces an organization's base earn rate (OCT-341): publishes policy version
   * `fromPolicyVersion + 1` with `earnBps` (same expiry) and activates it, then records it on the
   * `programs` row. Runs only for an approved `UPDATE_EARN_RATE` change request
   * (`EarnRateChangeProcessor`). `fromPolicyVersion` is the version the request was approved
   * against: if the row moved on since, nothing is sent (`ConflictException`).
   */
  async rotateEarnRate(params: { organizationId: string; earnBps: number; fromPolicyVersion: number }) {
    const program = await this.repo.findByOrganization(params.organizationId);
    if (program?.status !== 'ACTIVE' || !program.adminCapId || !program.programControlId) {
      throw new NotFoundException(`Organization ${params.organizationId} has no active program`);
    }
    if (program.policyVersion !== params.fromPolicyVersion) {
      throw new ConflictException(
        `Program policy is at version ${program.policyVersion}, not ${params.fromPolicyVersion}; the request is stale`,
      );
    }
    const version = program.policyVersion + 1;
    const { policyVersionId } = await this.admin.rotatePolicy({
      adminCapId: program.adminCapId,
      programId: program.programControlId,
      version,
      earnBps: params.earnBps,
      expiryMs: Number(program.expiryMs),
    });
    // From here the chain only accepts earns against the new policy: the row must follow.
    let updated: Awaited<ReturnType<ProgramsRepository['updatePolicy']>>;
    try {
      updated = await this.repo.updatePolicy(program.id, params.fromPolicyVersion, {
        policyVersionId,
        policyVersion: version,
        earnBps: params.earnBps,
      });
    } catch (err: unknown) {
      this.logger.error(
        `program ${program.id} activated policy ${policyVersionId} (version ${version}) on-chain but not recorded — repair manually`,
      );
      throw err;
    }
    if (!updated) {
      throw new Error(
        `program ${program.id} activated policy ${policyVersionId} (version ${version}) on-chain, but its row moved on — repair manually`,
      );
    }
    return updated;
  }

  /**
   * Refills an organization's on-chain issuance budget by `amount` credits, split across its
   * budget shards like the initial budget. The `programs` row's `totalBudget` stays the
   * provisioning-time figure; the chain's `BudgetShard.remaining` is the live one. Runs only for an
   * approved `BUDGET_TOP_UP` change request (`BudgetTopUpProcessor`).
   */
  async topUpBudget(params: { organizationId: string; amount: number }): Promise<BudgetShardTopUp[]> {
    const program = await this.repo.findByOrganization(params.organizationId);
    if (program?.status !== 'ACTIVE' || !program.adminCapId || !program.budgetShardIds?.length) {
      throw new NotFoundException(`Organization ${params.organizationId} has no active program with budget shards`);
    }
    return this.admin.topUpBudget({
      adminCapId: program.adminCapId,
      budgetShardIds: program.budgetShardIds,
      amount: params.amount,
    });
  }
}
