import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { VOUCHER_BATCH_MAX_ITEMS } from '@octap/contracts';
import type {
  VoucherBatchActionResponse,
  ConsoleVoucherInput,
  CreateVoucherBatchRequest,
  CreateVoucherBatchResponse,
  ConsoleVoucherPatch,
  VoucherBatchDetailDto,
  VoucherBatchDto,
  VoucherDto,
} from '@octap/contracts';
import {
  ConsoleAccessError,
  ConsoleOrganizationsRepository,
} from '#infra/db/repositories/console-organizations.repository.js';
import { UUID_PATTERN } from '#infra/db/repositories/console-access.js';
import type { VoucherActor } from '#infra/db/repositories/rewards.repository.js';
import { RewardsService } from './rewards.service.js';
import { VoucherBatchService } from './voucher-batch.service.js';

/**
 * The organization's reward catalog from the console session. The Owner and a Business Developer
 * read it and write drafts. Only the Owner pauses, changes a published voucher, and approves or
 * rejects. A Business Developer activates directly unless the organization requires approval
 * (`voucherApprovalRequired`); then they submit the draft and an Owner decides (OCT-59). Every rule
 * about the voucher itself is `RewardsService`'s, shared with `/v1/rewards/vouchers`.
 */
@Injectable()
export class ConsoleRewardsService {
  constructor(
    private readonly organizations: ConsoleOrganizationsRepository,
    private readonly rewards: RewardsService,
  ) {}

  private async run<T>(message: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ConsoleAccessError) throw new ForbiddenException(message);
      throw error;
    }
  }

  list(userId: string, orgId: string): Promise<VoucherDto[]> {
    return this.run(READ_DENIED, async () => {
      // Checked, then read after the check's transaction ends: one pooled connection at a time.
      await this.organizations.withAccess(userId, orgId, false, async () => undefined);
      return this.rewards.listVouchers(orgId);
    });
  }

  /** Another organization's voucher is a 404. */
  detail(userId: string, orgId: string, voucherId: string): Promise<VoucherDto> {
    return this.run(READ_DENIED, async () => {
      await this.organizations.withAccess(userId, orgId, false, async () => undefined);
      return this.rewards.getVoucher(orgId, voucherId);
    });
  }

  /**
   * Stricter than the API-key route: always a DRAFT, so activating is a separate, confirmed step
   * (`PATCH { status: 'ACTIVE' }`; the terms are frozen on-chain from then on), and `pointsCost` must
   * be sent, so a forgotten price never makes a free voucher. 0 is allowed when meant.
   */
  create(userId: string, orgId: string, input: ConsoleVoucherInput): Promise<VoucherDto> {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new BadRequestException('Voucher body must be an object');
    if (input.pointsCost === undefined) throw new BadRequestException('pointsCost is required (0 for a free reward)');
    if (input.status !== undefined && input.status !== 'DRAFT')
      throw new BadRequestException("A voucher is created as DRAFT; activate it with PATCH { status: 'ACTIVE' }");
    const req: ConsoleVoucherInput = { ...input, status: 'DRAFT' };
    return this.run(WRITE_DENIED, () =>
      this.organizations.withEditorAccess(userId, orgId, (tx, role) =>
        this.rewards.createVoucher(orgId, req, actorOf(userId, role), tx),
      ),
    );
  }

  /**
   * Edits fields, or pauses/activates with `{ status }`. A Business Developer edits drafts only, and
   * cannot pause. Another organization's voucher is a 404.
   */
  update(userId: string, orgId: string, voucherId: string, input: ConsoleVoucherPatch): Promise<VoucherDto> {
    // `expectedUpdatedAt` is the console's, about the review; the rest is the voucher's change.
    const { expectedUpdatedAt, ...change } = bodyOf(input) as ConsoleVoucherPatch & { expectedUpdatedAt?: unknown };
    const seen = expectedUpdatedAt === undefined ? null : timestampOf(expectedUpdatedAt, 'expectedUpdatedAt');
    return this.run(WRITE_DENIED, () =>
      this.organizations.withEditorAccess(userId, orgId, (tx, role) =>
        this.rewards.updateVoucher(orgId, voucherId, change, actorOf(userId, role), tx, seen),
      ),
    );
  }

  /** A Business Developer's draft goes to an Owner. An Owner activates directly instead. */
  submit(userId: string, orgId: string, voucherId: string): Promise<VoucherDto> {
    return this.run(WRITE_DENIED, () =>
      this.organizations.withEditorAccess(userId, orgId, (tx, role) => {
        if (role === 'OWNER')
          throw new ConflictException("An Owner needs no approval: activate it with PATCH { status: 'ACTIVE' }");
        return this.rewards.submitVoucher(orgId, voucherId, userId, tx);
      }),
    );
  }

  /** Back to DRAFT, by the Owner or a Business Developer. */
  withdraw(userId: string, orgId: string, voucherId: string): Promise<VoucherDto> {
    return this.run(WRITE_DENIED, () =>
      this.organizations.withEditorAccess(userId, orgId, (tx) =>
        this.rewards.withdrawVoucher(orgId, voucherId, userId, tx),
      ),
    );
  }

  /** `approvalRequestId` is the submission the Owner reviewed; a newer one is a 409 (OCT-324). */
  approve(
    userId: string,
    orgId: string,
    voucherId: string,
    input: { approvalRequestId?: unknown } | null,
  ): Promise<VoucherDto> {
    const body = bodyOf(input);
    if (Object.keys(body).some((key) => key !== 'approvalRequestId'))
      throw new BadRequestException('Only approvalRequestId may be sent');
    const approvalRequestId = reviewedSubmission(body);
    return this.run(REVIEW_DENIED, () =>
      this.organizations.withOwnerAccess(userId, orgId, (tx) =>
        this.rewards.approveVoucher(orgId, voucherId, userId, approvalRequestId, tx),
      ),
    );
  }

  reject(
    userId: string,
    orgId: string,
    voucherId: string,
    input: { approvalRequestId?: unknown; reason?: unknown } | null,
  ): Promise<VoucherDto> {
    const body = bodyOf(input);
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (Object.keys(body).some((key) => key !== 'reason' && key !== 'approvalRequestId'))
      throw new BadRequestException('Only approvalRequestId and reason may be sent');
    if (!reason || reason.length > 500)
      throw new BadRequestException('A rejection reason is required (up to 500 characters)');
    const approvalRequestId = reviewedSubmission(body);
    return this.run(REVIEW_DENIED, () =>
      this.organizations.withOwnerAccess(userId, orgId, (tx) =>
        this.rewards.rejectVoucher(orgId, voucherId, userId, approvalRequestId, reason, tx),
      ),
    );
  }
}

/**
 * Voucher batches from the console (OCT-303), with the same access as single vouchers: the Owner and a
 * Business Developer read, create, activate and archive them. Activating as a Business Developer while
 * the organization requires approval sends the batch to an Owner, as a single voucher's submission
 * does; the Owner's activation then approves it. Only the Owner pauses or resumes a batch.
 */
@Injectable()
export class ConsoleVoucherBatchService {
  constructor(
    private readonly organizations: ConsoleOrganizationsRepository,
    private readonly batches: VoucherBatchService,
  ) {}

  private async run<T>(message: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ConsoleAccessError) throw new ForbiddenException(message);
      throw error;
    }
  }

  list(userId: string, orgId: string, includeArchived?: unknown): Promise<VoucherBatchDto[]> {
    return this.run(READ_DENIED, async () => {
      await this.organizations.withAccess(userId, orgId, false, async () => undefined);
      return this.batches.list(orgId, includeArchived);
    });
  }

  detail(userId: string, orgId: string, batchId: string): Promise<VoucherBatchDetailDto> {
    return this.run(READ_DENIED, async () => {
      await this.organizations.withAccess(userId, orgId, false, async () => undefined);
      return this.batches.get(orgId, batchId);
    });
  }

  create(userId: string, orgId: string, input: CreateVoucherBatchRequest): Promise<CreateVoucherBatchResponse> {
    return this.run(WRITE_DENIED, () =>
      this.organizations.withEditorAccess(userId, orgId, (tx, role) =>
        this.batches.create(orgId, input, actorOf(userId, role), tx),
      ),
    );
  }

  /**
   * `seen` is each voucher as the Owner reviewed it (`{ voucherId, updatedAt }`). An Owner's activation
   * approves a waiting voucher, and publishes a draft while approval is required, only when it is
   * listed and unchanged since; any other is `failed`, with the reason (OCT-324).
   */
  activate(
    userId: string,
    orgId: string,
    batchId: string,
    input?: { seen?: unknown } | null,
  ): Promise<VoucherBatchActionResponse> {
    const body = bodyOf(input);
    if (Object.keys(body).some((key) => key !== 'seen')) throw new BadRequestException('Only seen may be sent');
    const seen = body.seen === undefined ? null : seenOf(body.seen);
    return this.run(WRITE_DENIED, () =>
      this.organizations.withEditorAccess(userId, orgId, (tx, role) =>
        this.batches.activate(orgId, batchId, actorOf(userId, role), tx, seen),
      ),
    );
  }

  archive(userId: string, orgId: string, batchId: string): Promise<VoucherBatchActionResponse> {
    return this.run(WRITE_DENIED, () =>
      this.organizations.withEditorAccess(userId, orgId, (tx, role) =>
        this.batches.archive(orgId, batchId, actorOf(userId, role), tx),
      ),
    );
  }

  /** Only the Owner pauses or resumes, as for a single voucher. */
  setPaused(userId: string, orgId: string, batchId: string, paused: boolean): Promise<VoucherBatchActionResponse> {
    return this.run(PAUSE_DENIED, () =>
      this.organizations.withOwnerAccess(userId, orgId, (tx) =>
        this.batches.setPaused(orgId, batchId, paused, actorOf(userId, 'OWNER'), tx),
      ),
    );
  }
}

function bodyOf<T extends object>(input: T | null | undefined): Partial<Record<keyof T, unknown>> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input : {};
}

/** The submission an Owner decides on: the voucher's `approval.id` when they reviewed it. */
function reviewedSubmission(body: { approvalRequestId?: unknown }): string {
  const id = body.approvalRequestId;
  if (typeof id !== 'string' || !UUID_PATTERN.test(id))
    throw new BadRequestException(
      "approvalRequestId is required: the id of the submission you reviewed (the voucher's approval.id)",
    );
  return id;
}

/** An ISO timestamp the console sent back, such as a voucher's `updatedAt`. */
function timestampOf(value: unknown, field: string): Date {
  const at = typeof value === 'string' ? new Date(value) : null;
  if (!at || Number.isNaN(at.getTime()))
    throw new BadRequestException(`${field} must be the voucher's updatedAt, an ISO timestamp`);
  return at;
}

const SEEN_SHAPE = `seen must be a list of up to ${VOUCHER_BATCH_MAX_ITEMS} { voucherId, updatedAt } as you reviewed them`;

/** The batch's vouchers as the Owner reviewed them, by voucher id. */
function seenOf(value: unknown): Map<string, Date> {
  if (!Array.isArray(value) || value.length > VOUCHER_BATCH_MAX_ITEMS) throw new BadRequestException(SEEN_SHAPE);
  const seen = new Map<string, Date>();
  for (const entry of value as unknown[]) {
    const { voucherId, updatedAt, ...rest } = (entry ?? {}) as { voucherId?: unknown; updatedAt?: unknown };
    if (
      typeof entry !== 'object' ||
      typeof voucherId !== 'string' ||
      !UUID_PATTERN.test(voucherId) ||
      Object.keys(rest).length
    )
      throw new BadRequestException(SEEN_SHAPE);
    seen.set(voucherId, timestampOf(updatedAt, 'seen[].updatedAt'));
  }
  return seen;
}

function actorOf(userId: string, role: 'OWNER' | 'BUSINESS_DEVELOPER'): VoucherActor {
  return role === 'OWNER' ? { role: 'OWNER', userId } : { role: 'DEVELOPER', userId };
}

const READ_DENIED = 'Only an active Owner or Business Developer of an active organization can view its rewards';
const WRITE_DENIED =
  'Only an active Owner or Business Developer of an active organization can create or change its rewards';
const PAUSE_DENIED = 'Only an active Owner of an active organization can pause or resume its rewards';
const REVIEW_DENIED = 'Only an active Owner of an active organization can approve or reject its rewards';
