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
  totalSupply?: number;
  startsAt?: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

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
  idempotencyKey?: string;
}

export interface ClaimVoucherResponse {
  voucherOwnershipId: string;
  voucherId: string;
  organizationEndUserId: string;
  serialCode: string;
  status: VoucherOwnershipStatus;
  pointsDeducted: number;
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
