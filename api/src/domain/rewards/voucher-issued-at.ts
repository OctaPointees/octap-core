import { eventField, type SubmittedChainTransaction } from '@octap/chain';

/**
 * When the chain issued a voucher: the `issued_at_ms` that `VoucherGranted` and `VoucherClaimed`
 * carry, a u64 rendered as a decimal string. The chain counts the voucher's own use deadline from
 * it, so PostgreSQL must too, whenever the confirmation runs. Throws rather than guess: an event
 * without it comes from a package this deployment doesn't speak.
 */
export function voucherIssuedAt(value: unknown): Date {
  const ms = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new Error(`voucher event has no usable issued_at_ms (${String(value)})`);
  }
  return new Date(ms);
}

/** `voucherIssuedAt` of the transaction's `eventName` event. */
export function voucherIssuedAtIn(
  result: SubmittedChainTransaction,
  eventName: 'VoucherGranted' | 'VoucherClaimed',
): Date {
  return voucherIssuedAt(eventField(result, eventName, 'issued_at_ms'));
}

/**
 * For a debit that may have bought a voucher (`claim_voucher`, or a plain `redeem`): the
 * `VoucherClaimed` issue time, or undefined when the transaction claimed no voucher.
 */
export function voucherClaimIssuedAt(result: SubmittedChainTransaction): Date | undefined {
  const value = eventField(result, 'VoucherClaimed', 'issued_at_ms');
  return value === undefined ? undefined : voucherIssuedAt(value);
}
