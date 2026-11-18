import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import type { SetVoucherRefundPolicyRequest, ListVoucherRefundPolicyHistoryRequest } from '@octap/contracts';
import {
  VoucherRefundPoliciesRepository,
  RefundPolicyOrganizationNotFoundError,
  type RefundPolicyAuthorize,
} from '#infra/db/repositories/voucher-refund-policies.repository.js';
import { validateRefundPolicy } from './refund-policy.js';

@Injectable()
export class RefundPolicyService {
  constructor(private readonly policies: VoucherRefundPoliciesRepository) {}
  current(organizationId: string) {
    return this.policies.current(organizationId);
  }
  async history(organizationId: string, query: ListVoucherRefundPolicyHistoryRequest = {}) {
    if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100))
      throw new BadRequestException('limit must be an integer from 1 to 100');
    if (
      query.beforeVersion !== undefined &&
      (!Number.isInteger(query.beforeVersion) || query.beforeVersion < 1 || query.beforeVersion > 2147483647)
    )
      throw new BadRequestException('beforeVersion must be a positive 32-bit integer');
    return this.policies.history(organizationId, query);
  }
  /** Publishing is the console's (`ConsoleRefundPolicyService`): `authorize` is its Owner check. */
  async publish(
    organizationId: string,
    userId: string,
    request: SetVoucherRefundPolicyRequest,
    authorize: RefundPolicyAuthorize,
  ) {
    validateRefundPolicy(request);
    try {
      return await this.policies.publish(organizationId, userId, request, authorize);
    } catch (error) {
      if (error instanceof RefundPolicyOrganizationNotFoundError) throw new NotFoundException('Organization not found');
      throw error;
    }
  }
}
