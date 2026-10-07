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
