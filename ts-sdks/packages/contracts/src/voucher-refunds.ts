/** Merchant refund terms, independent of the on-chain points earn/expiry policy. */
export interface VoucherRefundPolicy {
  allowUnused: boolean;
  /** Opt-in only; refund execution additionally requires an admin-scoped credential. */
  allowExpired: boolean;
  /** Exceptional service recovery; preserves REDEEMED history and requires admin-scoped refund execution. */
  allowRedeemed: boolean;
  /** False permanently consumes the campaign allocation even when an unused coupon is canceled. */
  restockUnused: boolean;
  /** Elapsed days since claim; null means no time limit. The boundary is exclusive. */
  refundWindowDays: number | null;
}

export interface VoucherRefundPolicySnapshot extends VoucherRefundPolicy {
  version: number;
}

export const DEFAULT_VOUCHER_REFUND_POLICY: Readonly<VoucherRefundPolicySnapshot> = Object.freeze({
  version: 0,
  allowUnused: true,
  allowExpired: false,
  allowRedeemed: false,
  restockUnused: true,
  refundWindowDays: null,
});

export interface SetVoucherRefundPolicyRequest extends VoucherRefundPolicy {
  reason: string;
}

export interface VoucherRefundPolicyDto extends VoucherRefundPolicySnapshot {
  reason: string;
  createdByCredentialId: string | null;
  createdAt: string | null;
}

export interface ListVoucherRefundPolicyHistoryRequest {
  /** 1-100; defaults to 50. */
  limit?: number;
  /** Exclusive version cursor, using the last version of the preceding page. */
  beforeVersion?: number;
}
