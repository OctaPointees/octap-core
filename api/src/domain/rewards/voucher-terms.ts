import { BadRequestException } from '@nestjs/common';
import { DEFAULT_VOUCHER_REFUND_POLICY, type VoucherRefundPolicySnapshot } from '@octap/contracts';
import { canonicalJson } from '#infra/db/repositories/operations.repository.js';

/** Stays well below Sui's limit on a pure transaction argument. */
export const MAX_VOUCHER_TERMS_BYTES = 8192;

export interface VoucherPromise {
  code: string;
  title: string;
  description?: string | null;
  discountType?: string | null;
  discountValue?: string | null;
  terms?: Record<string, unknown> | null;
  refundPolicySnapshot?: VoucherRefundPolicySnapshot | null;
}

/**
 * The bytes frozen on-chain as a voucher's promise. Canonical JSON, so anyone holding the same fields
 * gets the same bytes. Price and validity are separate fields of `VoucherTerms`, which Move enforces.
 */
export function buildVoucherTermsBytes(voucher: VoucherPromise): Uint8Array {
  return new TextEncoder().encode(
    canonicalJson({
      version: 1,
      code: voucher.code,
      title: voucher.title,
      description: voucher.description ?? null,
      discountType: voucher.discountType ?? null,
      discountValue: voucher.discountValue ?? null,
      terms: voucher.terms ?? null,
      refundPolicy: voucher.refundPolicySnapshot ?? DEFAULT_VOUCHER_REFUND_POLICY,
    }),
  );
}

export function assertVoucherTermsFit(voucher: VoucherPromise): void {
  if (buildVoucherTermsBytes(voucher).length > MAX_VOUCHER_TERMS_BYTES) {
    throw new BadRequestException(
      `Voucher terms, title and description must fit in ${MAX_VOUCHER_TERMS_BYTES} bytes because they are published on-chain`,
    );
  }
}
