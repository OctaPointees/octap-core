import type { VoucherRefundPolicySnapshot } from './voucher-refunds.js';

export type VoucherStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'EXPIRED' | 'DEPLETED';
export type VoucherOwnershipStatus = 'AVAILABLE' | 'RESERVED' | 'REDEEMED' | 'EXPIRED' | 'CANCELLED';
export type DiscountType = 'PERCENTAGE' | 'FIXED_AMOUNT' | 'FREE_ITEM';
/** Whether a voucher's terms are on-chain. Only a PUBLISHED voucher can be ACTIVE. */
export type VoucherPublishStatus = 'NOT_PUBLISHED' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED';

/**
 * How long a voucher must stay valid after it is claimed or granted. The contract enforces it, so a
 * voucher with less time than this left before `expiresAt` can't be activated, claimed or granted.
 */
export const VOUCHER_MIN_USE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The longest `validForDays` a voucher can promise; the contract refuses more. */
export const VOUCHER_MAX_VALID_FOR_DAYS = 3650;

/**
 * When one customer's voucher stops being usable, as the contract computes it
 * (`voucher_terms::use_deadline_ms`): `issuedAt + validForDays`, capped by the catalog's
 * `expiresAt`, or `expiresAt` alone without `validForDays`. `null` means it never expires.
 */
export function voucherUseDeadline(
  voucher: { expiresAt: Date | null; validForDays?: number | null },
  issuedAt: Date,
): Date | null {
  if (!voucher.validForDays) return voucher.expiresAt;
  const own = issuedAt.getTime() + voucher.validForDays * 86_400_000;
  return new Date(voucher.expiresAt === null ? own : Math.min(own, voucher.expiresAt.getTime()));
}

export interface CreateVoucherRequest {
  code: string;
  title: string;
  description?: string;
  pointsCost?: number;
  /** Required unless `terms` describes the benefit. */
  discountType?: DiscountType;
  discountValue?: string;
  /**
   * Your own description of the promise, in any shape. It is published on-chain with the rest of the
   * voucher's terms and cannot change afterwards, so it must hold no personal data.
   */
  terms?: Record<string, unknown>;
  /**
   * How many can be issued in all. `null`, or omitting it on create, is no limit.
   * @TJS-type ["integer", "null"]
   * @minimum 1
   * @maximum 2147483647
   */
  totalSupply?: number | null;
  /**
   * How many vouchers of this kind one member may hold. Used and expired ones count, even when
   * refunded later; cancelled ones (including an unused one that was refunded) don't. `null`, or
   * omitting it on create, is no limit. Stays editable after publishing,
   * like supply; lowering it never takes back vouchers already issued.
   * @TJS-type ["integer", "null"]
   * @minimum 1
   * @maximum 2147483647
   */
  perMemberLimit?: number | null;
  startsAt?: string | null;
  /**
   * When claims close. At least `VOUCHER_MIN_USE_WINDOW_MS` away when the voucher is activated.
   * Without `validForDays` it is also when every customer's voucher expires; with it, the cap on
   * each customer's own deadline.
   */
  expiresAt?: string | null;
  /**
   * Each customer's voucher stays usable this many days from when it is issued to them, capped by
   * `expiresAt`. 1 to `VOUCHER_MAX_VALID_FOR_DAYS`, or omit/`null` so every voucher expires at
   * `expiresAt`. Part of the on-chain promise: it cannot change once publishing starts.
   */
  validForDays?: number | null;
  metadata?: Record<string, unknown>;
  status?: 'DRAFT' | 'ACTIVE' | 'PAUSED';
}

export type UpdateVoucherRequest = Partial<CreateVoucherRequest>;

export interface VoucherDto {
  id: string;
  organizationId: string;
  code: string;
  title: string;
  description?: string | null;
  pointsCost: number;
  discountType?: string | null;
  discountValue?: string | null;
  terms?: Record<string, unknown> | null;
  publishStatus: VoucherPublishStatus;
  /** The frozen on-chain `VoucherTerms`, once published. */
  suiTermsId?: string | null;
  /** The refund policy published with the terms. */
  refundPolicy?: VoucherRefundPolicySnapshot | null;
  totalSupply?: number | null;
  /** `null` is no limit. */
  perMemberLimit: number | null;
  claimedCount: number;
  status: VoucherStatus;
  startsAt?: string | null;
  expiresAt?: string | null;
  /** `null`: every customer's voucher expires at `expiresAt`. */
  validForDays: number | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimVoucherRequest {
  organizationEndUserId: string;
  /** Persist the same key across retries. Use a new key only after a claim is CANCELLED. */
  idempotencyKey: string;
}

export interface ClaimVoucherResponse {
  refundPolicy?: VoucherRefundPolicySnapshot;
  voucherOwnershipId: string;
  voucherId: string;
  organizationEndUserId: string;
  serialCode: string;
  status: VoucherOwnershipStatus;
  /** Zero until the customer-signed debit is confirmed on-chain. */
  pointsDeducted: number;
  pointsCost?: number;
  transactionId?: string | null;
  /** Every claim is RESERVED until the chain confirms it. Only a paid claim has bytes to sign. */
  digest?: string | null;
  transactionBytes?: string | null;
  claimedAt: string;
  /**
   * This customer's own deadline (`voucherUseDeadline`). While RESERVED it is provisional: it is set
   * again when the chain issues the voucher, so time spent waiting for a signature doesn't count.
   */
  expiresAt?: string | null;
}

/** Gives a customer a voucher without spending their points. */
export interface GrantVoucherRequest {
  organizationEndUserId: string;
  /** Persist the same key across retries. */
  idempotencyKey: string;
}

/** Asks the customer to use a voucher. Only their signature marks it used. */
export interface PrepareVoucherUseRequest {
  serialCode: string;
  /** Persist the same key across retries. */
  idempotencyKey: string;
}

export interface PrepareVoucherUseResponse {
  voucherOwnershipId: string;
  voucherId: string;
  serialCode: string;
  /** AVAILABLE until the chain confirms the use. */
  status: VoucherOwnershipStatus;
  /** For the customer's device to sign. Null once the use has settled. */
  digest: string | null;
  transactionBytes: string | null;
  voucherTitle: string;
  discountType?: string | null;
  discountValue?: string | null;
}

export interface FinalizeVoucherUseRequest {
  digest: string;
  signature: string;
}

export interface RedeemVoucherResponse {
  voucherOwnershipId: string;
  voucherId: string;
  serialCode: string;
  status: VoucherOwnershipStatus;
  redeemedAt: string;
  voucherTitle: string;
  discountType?: string | null;
  discountValue?: string | null;
  /** The customer-signed transaction that marked it used. */
  blockchainDigest: string;
}

export interface VoucherOwnershipDto {
  refundPolicy?: VoucherRefundPolicySnapshot;
  id: string;
  voucherId: string;
  organizationEndUserId: string;
  serialCode: string;
  status: VoucherOwnershipStatus;
  claimedAt: string;
  redeemedAt?: string | null;
  /**
   * This customer's own deadline (`voucherUseDeadline`). While RESERVED it is provisional: it is set
   * again when the chain issues the voucher, so time spent waiting for a signature doesn't count.
   */
  expiresAt?: string | null;
  voucher?: VoucherDto;
}
