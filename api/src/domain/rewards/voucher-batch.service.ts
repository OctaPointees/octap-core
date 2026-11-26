import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateVoucherBatchResponse,
  VoucherBatchActionResponse,
  VoucherBatchDetailDto,
  VoucherBatchDto,
  VoucherBatchItemResult,
} from '@octap/contracts';
import type { DrizzleDb } from '#infra/db/postgres.provider.js';
import { ProgramsRepository } from '#infra/db/repositories/programs.repository.js';
import {
  RewardsRepository,
  type VoucherActor,
  type VoucherBatch,
  type VoucherBatchActionRow,
  type VoucherBatchWriteResult,
} from '#infra/db/repositories/rewards.repository.js';
import { requireProgramConfig } from '../programs/program-config.js';
import { toHttpError, toVoucherDto } from './rewards.service.js';
import { checkBatchItems, parseBatchRequest, voucherDifferences } from './voucher-batch.js';

async function mapErrors<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    throw toHttpError(error);
  }
}

/**
 * Voucher batches (OCT-303): many vouchers created as one DRAFT batch, reviewed, then activated or
 * archived together. Shared by the API-key routes and the console's, like `RewardsService`. `actor`
 * follows OCT-59's rules: activating as anyone but an Owner, while the organization requires approval,
 * sends the whole batch to an Owner instead of publishing it.
 */
@Injectable()
export class VoucherBatchService {
  constructor(
    private readonly rewardsRepo: RewardsRepository,
    private readonly programsRepo: ProgramsRepository,
  ) {}

  /**
   * Request-level problems (not an object, no items, more than the limit) are a 400 for the whole call.
   * Every item is then checked and written on its own, and its result reported at its `index`.
   */
  async create(
    organizationId: string,
    body: unknown,
    actor: VoucherActor,
    tx?: DrizzleDb,
  ): Promise<CreateVoucherBatchResponse> {
    const { items, dryRun, name } = parseBatchRequest(body);
    const { valid, invalid } = checkBatchItems(items);
    const written = await mapErrors(
      this.rewardsRepo.createVoucherBatch(
        organizationId,
        valid.map((item) => ({ ...item, compare: (stored) => voucherDifferences(stored, item.values) })),
        actor,
        dryRun,
        name,
        tx,
      ),
    );
    const codes = new Map(valid.map((item) => [item.index, item.code]));
    const results: VoucherBatchItemResult[] = [
      ...invalid.map((item): VoucherBatchItemResult => ({ ...item, status: 'error' })),
      ...written.results.map((result) => itemResult(result, codes.get(result.index) ?? '')),
    ].sort((a, b) => a.index - b.index);
    return {
      dryRun,
      batch: written.batch ? await this.batchDto(organizationId, written.batch, tx) : null,
      items: results,
    };
  }

  async list(organizationId: string, includeArchived: unknown, tx?: DrizzleDb): Promise<VoucherBatchDto[]> {
    await this.rewardsRepo.expireDueFor(organizationId, tx);
    const batches = await this.rewardsRepo.listVoucherBatches(organizationId, parseFlag(includeArchived), tx);
    const counts = await this.rewardsRepo.voucherBatchStatusCounts(
      organizationId,
      batches.map((b) => b.id),
      tx,
    );
    return batches.map((batch) => toBatchDto(batch, counts.get(batch.id) ?? {}));
  }

  /** Another organization's batch is a 404. */
  async get(organizationId: string, batchId: string, tx?: DrizzleDb): Promise<VoucherBatchDetailDto> {
    await this.rewardsRepo.expireDueFor(organizationId, tx);
    const found = await this.rewardsRepo.findVoucherBatch(organizationId, batchId, tx);
    if (!found) throw new NotFoundException('Voucher batch not found');
    const approvals = await this.rewardsRepo.latestApprovals(
      organizationId,
      found.vouchers.map((v) => v.id),
      tx,
    );
    return {
      ...(await this.batchDto(organizationId, found.batch, tx)),
      vouchers: found.vouchers.map((v) => toVoucherDto(v, approvals.get(v.id) ?? null)),
    };
  }

  /**
   * The program check is made once, for the whole call (422): it is the organization's, not any one
   * voucher's. The 24-hour and supply checks are made for each voucher, now, not taken from a preview.
   * `seen`: each voucher's `updatedAt` as the Owner reviewed it, by voucher id (OCT-324).
   */
  async activate(
    organizationId: string,
    batchId: string,
    actor: VoucherActor,
    tx?: DrizzleDb,
    seen: ReadonlyMap<string, Date> | null = null,
  ): Promise<VoucherBatchActionResponse> {
    await this.requireProgram(organizationId, tx);
    return this.actionResponse(
      organizationId,
      await mapErrors(this.rewardsRepo.activateVoucherBatch(organizationId, batchId, actor, tx, seen)),
      tx,
    );
  }

  /** Pauses (`paused: true`) or resumes every voucher of the batch that is on-chain. */
  async setPaused(
    organizationId: string,
    batchId: string,
    paused: boolean,
    actor: VoucherActor,
    tx?: DrizzleDb,
  ): Promise<VoucherBatchActionResponse> {
    return this.actionResponse(
      organizationId,
      await mapErrors(this.rewardsRepo.setVoucherBatchPaused(organizationId, batchId, paused, actor, tx)),
      tx,
    );
  }

  private async requireProgram(organizationId: string, tx?: DrizzleDb) {
    await requireProgramConfig(
      { findByOrganization: (id: string) => this.programsRepo.findByOrganization(id, tx) },
      organizationId,
    );
  }

  /** The batch, with its counts read after the action, and each voucher's outcome. */
  private async actionResponse(
    organizationId: string,
    { batch, results }: { batch: VoucherBatch; results: VoucherBatchActionRow[] },
    tx?: DrizzleDb,
  ): Promise<VoucherBatchActionResponse> {
    return {
      batch: await this.batchDto(organizationId, batch, tx),
      vouchers: results.map(({ voucher, outcome, reason }) => ({
        voucherId: voucher.id,
        code: voucher.code,
        outcome,
        status: voucher.status,
        reason,
      })),
    };
  }

  /**
   * Archives the batch: its vouchers that never went live become `ARCHIVED` (one waiting for approval
   * has its request withdrawn); live ones are untouched. Archiving again only reports.
   */
  async archive(
    organizationId: string,
    batchId: string,
    actor: VoucherActor,
    tx?: DrizzleDb,
  ): Promise<VoucherBatchActionResponse> {
    return this.actionResponse(
      organizationId,
      await mapErrors(this.rewardsRepo.archiveVoucherBatch(organizationId, batchId, actor, tx)),
      tx,
    );
  }

  private async batchDto(organizationId: string, batch: VoucherBatch, tx?: DrizzleDb): Promise<VoucherBatchDto> {
    const counts = await this.rewardsRepo.voucherBatchStatusCounts(organizationId, [batch.id], tx);
    return toBatchDto(batch, counts.get(batch.id) ?? {});
  }
}

function itemResult(result: VoucherBatchWriteResult, code: string): VoucherBatchItemResult {
  switch (result.kind) {
    case 'created':
      return { index: result.index, code, status: 'created', voucherId: result.voucher?.id ?? null };
    case 'unchanged':
      return {
        index: result.index,
        code,
        status: 'unchanged',
        voucherId: result.voucher.id,
        movedToBatch: result.moved,
      };
    case 'conflict':
    case 'replaced':
      return {
        index: result.index,
        code,
        status: result.kind,
        voucherId: result.voucher.id,
        differences: result.differences,
      };
  }
}

function toBatchDto(batch: VoucherBatch, statusCounts: VoucherBatchDto['statusCounts']): VoucherBatchDto {
  return {
    id: batch.id,
    organizationId: batch.organizationId,
    name: batch.name,
    source: batch.source,
    createdBy: batch.createdByCredentialId
      ? { type: 'API_CREDENTIAL', id: batch.createdByCredentialId }
      : batch.createdByUserId
        ? { type: 'USER', id: batch.createdByUserId }
        : null,
    createdAt: batch.createdAt.toISOString(),
    archivedAt: batch.archivedAt?.toISOString() ?? null,
    statusCounts,
  };
}

/** `?includeArchived=true` arrives as a string; a boolean is fine too. */
function parseFlag(value: unknown): boolean {
  if (value === undefined || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  throw new BadRequestException('includeArchived must be true or false');
}
