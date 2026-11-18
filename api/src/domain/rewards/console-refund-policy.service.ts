import { ForbiddenException, Injectable } from '@nestjs/common';
import type {
  ListVoucherRefundPolicyHistoryRequest,
  SetVoucherRefundPolicyRequest,
  VoucherRefundPolicyDto,
} from '@octap/contracts';
import { ConsoleAccessError } from '#infra/db/repositories/console-access.js';
import { ConsoleOrganizationsRepository } from '#infra/db/repositories/console-organizations.repository.js';
import { RefundPolicyService } from './refund-policy.service.js';

/**
 * The organization's voucher refund policy from the console session. Owner only, reads included; a
 * Business Developer is a 403. Publishing is console-only: the policy is the only gate on which
 * coupons a `write` key may refund, so it is never set with an API key. Each version records the
 * Owner who published it. Every rule about the policy itself is `RefundPolicyService`'s.
 */
@Injectable()
export class ConsoleRefundPolicyService {
  constructor(
    private readonly organizations: ConsoleOrganizationsRepository,
    private readonly policies: RefundPolicyService,
  ) {}

  private async run<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ConsoleAccessError) throw new ForbiddenException(DENIED);
      throw error;
    }
  }

  current(userId: string, orgId: string): Promise<VoucherRefundPolicyDto> {
    return this.run(async () => {
      // Checked, then read after the check's transaction ends: one pooled connection at a time.
      await this.organizations.withOwnerAccess(userId, orgId, async () => undefined);
      return this.policies.current(orgId);
    });
  }

  history(
    userId: string,
    orgId: string,
    query: ListVoucherRefundPolicyHistoryRequest = {},
  ): Promise<VoucherRefundPolicyDto[]> {
    return this.run(async () => {
      await this.organizations.withOwnerAccess(userId, orgId, async () => undefined);
      return this.policies.history(orgId, query);
    });
  }

  /** The Owner check runs inside the publishing transaction, after its organization lock. */
  publish(userId: string, orgId: string, request: SetVoucherRefundPolicyRequest): Promise<VoucherRefundPolicyDto> {
    return this.run(() =>
      this.policies.publish(orgId, userId, request, (tx) => this.organizations.assertOwner(tx, userId, orgId)),
    );
  }
}

const DENIED = 'Only an active Owner of an active organization can view or change its refund policy';
