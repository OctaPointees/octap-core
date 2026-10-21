export interface EarnPointsBodyDto {
  organizationEndUserId: string;
  pointsAmount: number;
  idempotencyKey: string;
  receiptReference?: string;
  metadata?: Record<string, unknown>;
}

export interface RedeemPointsBodyDto {
  organizationEndUserId: string;
  pointsAmount: number;
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
}

export interface FinalizePosRedemptionBodyDto {
  digest: string;
  signature: string;
}
