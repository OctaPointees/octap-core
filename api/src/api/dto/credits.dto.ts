export interface EarnPointsBodyDto {
  organizationEndUserId: string;
  purchaseAmount: number;
  idempotencyKey: string;
  receiptReference?: string;
  metadata?: Record<string, unknown>;
}

export interface ReverseTransactionBodyDto {
  idempotencyKey: string;
  reason: string;
}

export interface ReservePosRedemptionBodyDto {
  organizationEndUserId: string;
  pointsAmount: number;
  idempotencyKey: string;
  orderReference: string;
  discountAmount: number;
  currency: string;
}

export interface FinalizePosRedemptionBodyDto {
  digest: string;
  signature: string;
}

/** `GET /v1/credits/transactions` and the console's organization history. See `OrganizationTransactionQuery`. */
export interface OrganizationTransactionQueryDto {
  limit?: string;
  cursor?: string;
  type?: 'EARN' | 'REDEEM' | 'REVERSAL' | 'TRANSFER' | 'EXPIRY' | 'ADJUSTMENT';
  status?: 'PENDING' | 'CONFIRMED' | 'FAILED' | 'REVERSED';
  memberId?: string;
}
