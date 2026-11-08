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
