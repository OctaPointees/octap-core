import { describe, expect, it } from 'vitest';
import { DEFAULT_VOUCHER_REFUND_POLICY } from '@octap/contracts';
import { assertVoucherTermsFit, buildVoucherTermsBytes } from '#domain/rewards/voucher-terms.js';

const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));

describe('buildVoucherTermsBytes', () => {
  it('holds the whole promise, including the refund policy published with it', () => {
    const policy = { ...DEFAULT_VOUCHER_REFUND_POLICY, version: 3, allowExpired: true };
    expect(
      decode(
        buildVoucherTermsBytes({
          code: 'COFFEE',
          title: 'Free coffee',
          description: 'Any size',
          discountType: 'FREE_ITEM',
          terms: { fineprint: 'One per visit' },
          refundPolicySnapshot: policy,
        }),
      ),
    ).toEqual({
      version: 1,
      code: 'COFFEE',
      title: 'Free coffee',
      description: 'Any size',
      discountType: 'FREE_ITEM',
      discountValue: null,
      terms: { fineprint: 'One per visit' },
      refundPolicy: policy,
    });
  });

  it('falls back to the default policy, and leaves out nothing a merchant did not set', () => {
    expect(decode(buildVoucherTermsBytes({ code: 'C', title: 'T' }))).toEqual({
      version: 1,
      code: 'C',
      title: 'T',
      description: null,
      discountType: null,
      discountValue: null,
      terms: null,
      refundPolicy: DEFAULT_VOUCHER_REFUND_POLICY,
    });
  });

  it('gives the same bytes whatever order the free-form keys arrive in', () => {
    const a = buildVoucherTermsBytes({ code: 'C', title: 'T', terms: { a: 1, b: { c: 2, d: 3 } } });
    const b = buildVoucherTermsBytes({ code: 'C', title: 'T', terms: { b: { d: 3, c: 2 }, a: 1 } });
    expect(b).toEqual(a);
  });
});

describe('assertVoucherTermsFit', () => {
  it('counts bytes, not characters, because that is what the chain stores', () => {
    expect(() => assertVoucherTermsFit({ code: 'C', title: 'T', description: 'a'.repeat(4000) })).not.toThrow();
    expect(() => assertVoucherTermsFit({ code: 'C', title: 'T', description: 'ế'.repeat(4000) })).toThrow(/8192 bytes/);
  });
});
