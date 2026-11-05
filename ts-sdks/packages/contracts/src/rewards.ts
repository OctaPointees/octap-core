import type { VoucherRefundPolicySnapshot } from './voucher-refunds.js';

export type VoucherStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'EXPIRED' | 'DEPLETED';
export type VoucherOwnershipStatus = 'AVAILABLE' | 'RESERVED' | 'REDEEMED' | 'EXPIRED' | 'CANCELLED';
export type DiscountType = 'PERCENTAGE' | 'FIXED_AMOUNT' | 'FREE_ITEM';
/** Whether a voucher's terms are on-chain. Only a PUBLISHED voucher can be ACTIVE. */
export type VoucherPublishStatus = 'NOT_PUBLISHED' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED';

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
  totalSupply?: number | null;
  startsAt?: string | null;
  expiresAt?: string | null;
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
  claimedCount: number;
  status: VoucherStatus;
  startsAt?: string | null;
  expiresAt?: string | null;
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
  expiresAt?: string | null;
  voucher?: VoucherDto;
}
