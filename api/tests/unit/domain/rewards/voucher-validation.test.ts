import { describe, expect, it } from 'vitest';
import { validateVoucher } from '#domain/rewards/voucher-validation.js';
import type { CreateVoucherRequest } from '@octap/contracts';

const valid: CreateVoucherRequest = { code: 'COFFEE', title: 'Coffee', discountType: 'FREE_ITEM', pointsCost: 25 };
describe('voucher input validation', () => {
  it.each([
    { ...valid },
    { ...valid, discountType: 'PERCENTAGE', discountValue: '10.50' },
    { ...valid, discountType: 'FIXED_AMOUNT', discountValue: '1000', totalSupply: null },
    { code: 'FREEFORM', title: 'Free-form', terms: { benefit: 'Two nights for one' } },
    { ...valid, startsAt: '2030-01-01T00:00:00Z', expiresAt: '2030-02-01T00:00:00+07:00', metadata: {} },
    { ...valid, startsAt: '2028-02-29T23:59:59.999-07:00' },
  ])('accepts a valid reward: %j', (input) =>
    expect(() => validateVoucher(input as CreateVoucherRequest)).not.toThrow(),
  );

  it.each([
    null,
    [],
    { ...valid, code: '' },
    { ...valid, code: 'bad code' },
    { ...valid, title: ' ' },
    { ...valid, description: 1 },
    { ...valid, pointsCost: -1 },
    { ...valid, pointsCost: 1.5 },
    { ...valid, pointsCost: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, totalSupply: 0 },
    { ...valid, totalSupply: 1.1 },
    { ...valid, totalSupply: 2147483648 },
    { ...valid, discountType: 'UNKNOWN' },
    { code: 'NEITHER', title: 'Neither' },
    { ...valid, terms: ['not', 'an', 'object'] },
    { ...valid, terms: null },
    { ...valid, terms: { text: 'x'.repeat(9000) } },
    { ...valid, discountType: 'PERCENTAGE' },
    { ...valid, discountValue: 'NaN' },
    { ...valid, discountValue: '0' },
    { ...valid, discountValue: '1.001' },
    { ...valid, discountType: 'PERCENTAGE', discountValue: '101' },
    { ...valid, startsAt: 'tomorrow' },
    { ...valid, expiresAt: '2030-01-01' },
    { ...valid, startsAt: '2030-02-30T00:00:00Z' },
    { ...valid, startsAt: '2026-02-29T00:00:00Z' },
    { ...valid, startsAt: '2030-04-31T00:00:00Z' },
    { ...valid, startsAt: '2030-01-01T24:00:00Z' },
    { ...valid, startsAt: '2030-01-01T00:60:00Z' },
    { ...valid, startsAt: '2030-01-01T00:00:60Z' },
    { ...valid, startsAt: '2030-01-01T00:00:00+24:00' },
    { ...valid, startsAt: '2030-01-01T00:00:00+07:60' },
    { ...valid, startsAt: '0000-01-01T00:00:00Z' },
    { ...valid, startsAt: '2030-02-01T00:00:00Z', expiresAt: '2030-01-01T00:00:00Z' },
    { ...valid, metadata: [] },
    { ...valid, metadata: null },
    { ...valid, status: 'DEPLETED' },
    { ...valid, claimedCount: 100 },
  ])('rejects malformed reward: %j', (input) => expect(() => validateVoucher(input as CreateVoucherRequest)).toThrow());

  it('allows partial edits without silently applying defaults', () => {
    expect(() => validateVoucher({ title: 'New title' }, true)).not.toThrow();
    expect(() => validateVoucher({ startsAt: null, expiresAt: null }, true)).not.toThrow();
  });
});
