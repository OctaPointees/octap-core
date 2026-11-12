import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { ConsoleVoucherInput, UpdateVoucherRequest, VoucherDto } from '@octap/contracts';
import {
  ConsoleAccessError,
  ConsoleOrganizationsRepository,
} from '#infra/db/repositories/console-organizations.repository.js';
import { RewardsService } from './rewards.service.js';

/**
 * The organization's reward catalog from the console session. The Owner and a Business Developer
 * read it; only the Owner creates, edits, pauses and activates. Every rule about the voucher itself
 * is `RewardsService`'s, shared with `/v1/rewards/vouchers`.
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
      this.organizations.withOwnerAccess(userId, orgId, (tx) => this.rewards.createVoucher(orgId, req, tx)),
    );
  }

  /** Edits fields, or pauses/activates with `{ status }`. Another organization's voucher is a 404. */
  update(userId: string, orgId: string, voucherId: string, input: UpdateVoucherRequest): Promise<VoucherDto> {
    return this.run(WRITE_DENIED, () =>
      this.organizations.withOwnerAccess(userId, orgId, (tx) =>
        this.rewards.updateVoucher(orgId, voucherId, input, tx),
      ),
    );
  }
}

const READ_DENIED = 'Only an active Owner or Business Developer of an active organization can view its rewards';
const WRITE_DENIED = 'Only an active Owner of an active organization can create or change its rewards';
