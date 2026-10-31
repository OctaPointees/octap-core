export type VoucherStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'EXPIRED' | 'DEPLETED';
export type VoucherOwnershipStatus = 'AVAILABLE' | 'RESERVED' | 'REDEEMED' | 'EXPIRED' | 'CANCELLED';
export type DiscountType = 'PERCENTAGE' | 'FIXED_AMOUNT' | 'FREE_ITEM';

export interface CreateVoucherRequest {
  code: string;
  title: string;
  description?: string;
  pointsCost?: number;
  discountType: DiscountType;
  discountValue?: string;
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
  discountType: string;
  discountValue?: string | null;
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
  /** Required for paid claims; persist the same key across retries. */
  idempotencyKey?: string;
}

export interface ClaimVoucherResponse {
  voucherOwnershipId: string;
  voucherId: string;
  organizationEndUserId: string;
  serialCode: string;
  status: VoucherOwnershipStatus;
  /** Zero until the customer-signed debit is confirmed on-chain. */
  pointsDeducted: number;
  pointsCost?: number;
  transactionId?: string | null;
  /** Paid claims are RESERVED until finalize/indexer confirmation. */
  digest?: string | null;
  transactionBytes?: string | null;
  claimedAt: string;
  expiresAt?: string | null;
}

export interface RedeemVoucherRequest {
  serialCode: string;
  receiptReference?: string;
}

export interface RedeemVoucherResponse {
  voucherOwnershipId: string;
  voucherId: string;
  serialCode: string;
  status: VoucherOwnershipStatus;
  redeemedAt: string;
  voucherTitle: string;
  discountType: string;
  discountValue?: string | null;
}

export interface VoucherOwnershipDto {
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
