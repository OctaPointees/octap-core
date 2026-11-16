import { describe, expect, it } from 'vitest';
import { voucherUseDurationMs } from '@octap/contracts';
import { voucherClaimIssuedAt, voucherIssuedAt, voucherIssuedAtIn } from '#domain/rewards/voucher-issued-at.js';

const event = (name: string, parsedJson: unknown) => ({ type: `0xpkg::credit_account::${name}`, parsedJson });
const tx = (...events: ReturnType<typeof event>[]) => ({ digest: 'D', status: 'success' as const, events });

describe('voucherIssuedAt', () => {
  it('reads the u64 the chain renders as a decimal string', () => {
    expect(voucherIssuedAt('1767225600000')).toEqual(new Date(1767225600000));
    expect(voucherIssuedAtIn(tx(event('VoucherGranted', { issued_at_ms: '1767225600000' })), 'VoucherGranted')).toEqual(
      new Date(1767225600000),
    );
  });

  it('refuses to guess when the event lacks it, as an old package’s would', () => {
    expect(() => voucherIssuedAt(undefined)).toThrow(/issued_at_ms/);
    expect(() => voucherIssuedAt('0')).toThrow(/issued_at_ms/);
    expect(() => voucherIssuedAtIn(tx(event('VoucherGranted', {})), 'VoucherGranted')).toThrow(/issued_at_ms/);
  });

  it('a debit that bought no voucher has no issue time', () => {
    expect(voucherClaimIssuedAt(tx(event('CreditRedeemed', { amount: '5' })))).toBeUndefined();
    expect(
      voucherClaimIssuedAt(
        tx(event('CreditRedeemed', { amount: '5' }), event('VoucherClaimed', { issued_at_ms: '1767225600000' })),
      ),
    ).toEqual(new Date(1767225600000));
  });
});

describe('voucherUseDurationMs', () => {
  it('is the use_duration_ms the publish worker sends, 0 when unused', () => {
    expect(voucherUseDurationMs({ validForDays: 14 })).toBe(14 * 86_400_000);
    expect(voucherUseDurationMs({ validForDays: null })).toBe(0);
    expect(voucherUseDurationMs({})).toBe(0);
  });
});
