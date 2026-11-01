import { BadRequestException } from '@nestjs/common';
import type { SetVoucherRefundPolicyRequest } from '@octap/contracts';
import type { VoucherRefundContext, VoucherRefundDecision } from '#infra/db/repositories/credits.repository.js';

export function validateRefundPolicy(input: SetVoucherRefundPolicyRequest): void {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new BadRequestException('Refund policy must be an object');
  const flags = ['allowUnused', 'allowExpired', 'allowRedeemed', 'restockUnused'] as const;
  const allowed = [...flags, 'refundWindowDays', 'reason'];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new BadRequestException('Refund policy contains unsupported fields');
  for (const flag of flags) {
    if (typeof input[flag] !== 'boolean') throw new BadRequestException(`${flag} must be a boolean`);
  }
  if (
    input.refundWindowDays !== null &&
    (!Number.isInteger(input.refundWindowDays) || input.refundWindowDays < 1 || input.refundWindowDays > 3650)
  )
    throw new BadRequestException('refundWindowDays must be null or an integer from 1 to 3650');
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 1000)
    throw new BadRequestException('A policy change reason of 1-1000 characters is required');
}

/** Called with the current coupon under its catalog/ownership locks, never with a stale pre-read. */
export function evaluateVoucherRefund(coupon: VoucherRefundContext, nowMs = Date.now()): VoucherRefundDecision {
  const policy = coupon.refundPolicySnapshot;
  const expired = coupon.status === 'EXPIRED' || (coupon.expiresAt !== null && coupon.expiresAt.getTime() <= nowMs);
  const couponStatus = coupon.status === 'AVAILABLE' && expired ? 'EXPIRED' : coupon.status;
  const deny = (reason: string): VoucherRefundDecision => ({ allowed: false, couponStatus, reason });
  if (!['AVAILABLE', 'EXPIRED', 'REDEEMED'].includes(coupon.status)) return deny('This coupon state is not refundable');
  if (policy.refundWindowDays !== null && nowMs >= coupon.claimedAt.getTime() + policy.refundWindowDays * 86400000)
    return deny('The refund window has ended');
  // Delivery takes precedence over expiry: refunding a used coupon never replenishes catalog stock.
  if (coupon.status === 'REDEEMED')
    return policy.allowRedeemed
      ? { allowed: true, nextStatus: 'REDEEMED', restock: false, reason: 'Redeemed coupon refund permitted' }
      : deny('Redeemed coupon refunds are disabled');
  if (expired)
    return policy.allowExpired
      ? { allowed: true, nextStatus: 'EXPIRED', restock: false, reason: 'Expired coupon refund permitted' }
      : deny('Expired coupon refunds are disabled');
  return policy.allowUnused
    ? {
        allowed: true,
        nextStatus: 'CANCELLED',
        restock: policy.restockUnused,
        reason: 'Unused coupon refund permitted',
      }
    : deny('Unused coupon refunds are disabled');
}
