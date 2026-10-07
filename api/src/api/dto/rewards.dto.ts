import type { DiscountType } from '@octap/contracts';

export interface CreateVoucherBodyDto {
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

export interface ClaimVoucherBodyDto {
  organizationEndUserId: string;
  idempotencyKey?: string;
}

export interface RedeemVoucherBodyDto {
  serialCode: string;
  receiptReference?: string;
}
