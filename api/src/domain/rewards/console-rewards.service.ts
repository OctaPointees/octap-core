import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import type {
  ActivateVoucherBatchResponse,
  ConsoleVoucherInput,
  CreateVoucherBatchRequest,
  CreateVoucherBatchResponse,
  UpdateVoucherRequest,
  VoucherBatchDetailDto,
  VoucherBatchDto,
  VoucherDto,
} from '@octap/contracts';
import {
  ConsoleAccessError,
  ConsoleOrganizationsRepository,
} from '#infra/db/repositories/console-organizations.repository.js';
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
  update(userId: string, orgId: string, voucherId: string, input: UpdateVoucherRequest): Promise<VoucherDto> {
    return this.run(WRITE_DENIED, () =>
      this.organizations.withEditorAccess(userId, orgId, (tx, role) =>
        this.rewards.updateVoucher(orgId, voucherId, input, actorOf(userId, role), tx),
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

  approve(userId: string, orgId: string, voucherId: string): Promise<VoucherDto> {
    return this.run(REVIEW_DENIED, () =>
      this.organizations.withOwnerAccess(userId, orgId, (tx) =>
        this.rewards.approveVoucher(orgId, voucherId, userId, tx),
      ),
    );
  }

  reject(userId: string, orgId: string, voucherId: string, input: { reason?: unknown } | null): Promise<VoucherDto> {
    const body = input && typeof input === 'object' ? input : {};
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason || reason.length > 500 || Object.keys(body).some((key) => key !== 'reason'))
      throw new BadRequestException('A rejection reason is required (up to 500 characters)');
    return this.run(REVIEW_DENIED, () =>
      this.organizations.withOwnerAccess(userId, orgId, (tx) =>
        this.rewards.rejectVoucher(orgId, voucherId, userId, reason, tx),
      ),
    );
  }
}

/**
 * Voucher batches from the console (OCT-303), with the same access as single vouchers: the Owner and a
 * Business Developer read, create, activate and archive them. Activating as a Business Developer while
 * the organization requires approval sends the batch to an Owner, as a single voucher's submission does.
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

  activate(userId: string, orgId: string, batchId: string): Promise<ActivateVoucherBatchResponse> {
    return this.run(WRITE_DENIED, () =>
      this.organizations.withEditorAccess(userId, orgId, (tx, role) =>
        this.batches.activate(orgId, batchId, actorOf(userId, role), tx),
      ),
    );
  }

  archive(userId: string, orgId: string, batchId: string): Promise<VoucherBatchDto> {
    return this.run(WRITE_DENIED, () =>
      this.organizations.withEditorAccess(userId, orgId, (tx) => this.batches.archive(orgId, batchId, tx)),
    );
  }
}

function actorOf(userId: string, role: 'OWNER' | 'BUSINESS_DEVELOPER'): VoucherActor {
  return role === 'OWNER' ? { role: 'OWNER', userId } : { role: 'DEVELOPER', userId };
}

const READ_DENIED = 'Only an active Owner or Business Developer of an active organization can view its rewards';
const WRITE_DENIED =
  'Only an active Owner or Business Developer of an active organization can create or change its rewards';
const REVIEW_DENIED = 'Only an active Owner of an active organization can approve or reject its rewards';
