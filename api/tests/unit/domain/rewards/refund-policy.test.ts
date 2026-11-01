import { describe, expect, it } from 'vitest';
import { DEFAULT_VOUCHER_REFUND_POLICY, type SetVoucherRefundPolicyRequest } from '@octap/contracts';
import { evaluateVoucherRefund, validateRefundPolicy } from '#domain/rewards/refund-policy.js';
import type { VoucherRefundContext } from '#infra/db/repositories/credits.repository.js';

const now = Date.parse('2030-01-10T00:00:00Z');
const coupon = (overrides: Partial<VoucherRefundContext> = {}): VoucherRefundContext => ({
  status: 'AVAILABLE',
  claimedAt: new Date(now - 86400000),
  expiresAt: null,
  refundPolicySnapshot: { ...DEFAULT_VOUCHER_REFUND_POLICY },
  ...overrides,
});
const request: SetVoucherRefundPolicyRequest = {
  allowUnused: true,
  allowExpired: false,
  allowRedeemed: false,
  restockUnused: true,
  refundWindowDays: null,
  reason: 'New terms',
};

describe('voucher refund policy', () => {
  it('defaults to unused refunds with stock returned', () => {
    expect(evaluateVoucherRefund(coupon(), now)).toMatchObject({
      allowed: true,
      nextStatus: 'CANCELLED',
      restock: true,
    });
    validateRefundPolicy(request);
    validateRefundPolicy({ ...request, refundWindowDays: 3650 });
  });
  it.each(['CANCELLED', 'RESERVED', 'UNKNOWN'])('never refunds a %s coupon', (status) => {
    expect(evaluateVoucherRefund(coupon({ status }), now).allowed).toBe(false);
  });
  it.each(['REDEEMED', 'EXPIRED'])('only refunds %s when explicitly allowed and never restocks it', (status) => {
    expect(evaluateVoucherRefund(coupon({ status }), now).allowed).toBe(false);
    expect(
      evaluateVoucherRefund(
        coupon({
          status,
          refundPolicySnapshot: {
            ...DEFAULT_VOUCHER_REFUND_POLICY,
            allowRedeemed: true,
            allowExpired: true,
          },
        }),
        now,
      ),
    ).toMatchObject({ allowed: true, nextStatus: status, restock: false });
  });
  it('treats AVAILABLE past its expiry as expired, including the exact boundary', () => {
    const expired = coupon({ expiresAt: new Date(now) });
    expect(evaluateVoucherRefund(expired, now).allowed).toBe(false);
    expect(
      evaluateVoucherRefund(
        {
          ...expired,
          refundPolicySnapshot: {
            ...DEFAULT_VOUCHER_REFUND_POLICY,
            allowExpired: true,
          },
        },
        now,
      ),
    ).toMatchObject({ allowed: true, nextStatus: 'EXPIRED', restock: false });
  });
  it('can disable unused refunds, disable restocking, or limit the refund window', () => {
    expect(
      evaluateVoucherRefund(
        coupon({
          refundPolicySnapshot: {
            ...DEFAULT_VOUCHER_REFUND_POLICY,
            allowUnused: false,
          },
        }),
        now,
      ).allowed,
    ).toBe(false);
    expect(
      evaluateVoucherRefund(
        coupon({
          refundPolicySnapshot: {
            ...DEFAULT_VOUCHER_REFUND_POLICY,
            restockUnused: false,
          },
        }),
        now,
      ),
    ).toMatchObject({ allowed: true, restock: false });
    const limited = coupon({ refundPolicySnapshot: { ...DEFAULT_VOUCHER_REFUND_POLICY, refundWindowDays: 1 } });
    expect(evaluateVoucherRefund(limited, now - 1).allowed).toBe(true);
    expect(evaluateVoucherRefund(limited, now).allowed).toBe(false);
  });
  it.each([
    null,
    [],
    {},
    { ...request, extra: true },
    { ...request, allowExpired: 'yes' },
    { ...request, reason: '' },
    { ...request, reason: 'x'.repeat(1001) },
    ...[0, -1, 1.5, 3651, '7', undefined].map((refundWindowDays) => ({ ...request, refundWindowDays })),
  ])('rejects malformed settings: %j', (input) => {
    expect(() => validateRefundPolicy(input as SetVoucherRefundPolicyRequest)).toThrow();
  });
});
