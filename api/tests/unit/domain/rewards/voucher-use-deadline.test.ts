import { describe, expect, it } from 'vitest';
import { voucherUseDeadline } from '@octap/contracts';

const DAY = 86_400_000;
const issuedAt = new Date('2030-03-03T00:00:00Z');

/** Mirrors `voucher_terms::use_deadline_ms`, which the contract enforces on `use_voucher`. */
describe('voucherUseDeadline', () => {
  it('is the catalog expiry without validForDays, or never', () => {
    const expiresAt = new Date('2030-04-01T00:00:00Z');
    expect(voucherUseDeadline({ expiresAt, validForDays: null }, issuedAt)).toEqual(expiresAt);
    expect(voucherUseDeadline({ expiresAt: null }, issuedAt)).toBeNull();
  });

  it('runs validForDays from the issue date', () => {
    expect(voucherUseDeadline({ expiresAt: null, validForDays: 14 }, issuedAt)).toEqual(
      new Date('2030-03-17T00:00:00Z'),
    );
  });

  it('is capped by the catalog expiry', () => {
    const expiresAt = new Date(issuedAt.getTime() + 10 * DAY);
    expect(voucherUseDeadline({ expiresAt, validForDays: 14 }, issuedAt)).toEqual(expiresAt);
    expect(voucherUseDeadline({ expiresAt, validForDays: 3 }, issuedAt)).toEqual(
      new Date(issuedAt.getTime() + 3 * DAY),
    );
  });
});
