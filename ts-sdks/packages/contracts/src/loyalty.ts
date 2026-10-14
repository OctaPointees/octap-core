/** Draft boundary types from the knowledge base; wire schemas remain to be designed. */
export type Points = string; // Decimal u64 string; validation is not implemented.
export interface ActorContext {
  tenantId: string;
  actorId: string;
  scopes: readonly string[];
}
export interface OperationReference {
  operation_id: string;
}
export interface BalanceSnapshot {
  confirmed_balance: Points;
  pending_earn: Points;
  pending_redemption: Points;
  as_of_checkpoint: string;
  observed_at: string;
  stale: boolean;
}

export type LoyaltyTxType = 'EARN' | 'REDEEM' | 'REVERSAL' | 'TRANSFER' | 'EXPIRY' | 'ADJUSTMENT';
export type LoyaltyTxStatus = 'PENDING' | 'CONFIRMED' | 'FAILED' | 'REVERSED';

export interface EarnPointsRequest {
  organizationEndUserId: string;
  pointsAmount: number;
  idempotencyKey: string;
  receiptReference?: string;
  metadata?: Record<string, unknown>;
}

export interface EarnPointsResponse {
  transactionId: string;
  organizationEndUserId: string;
  pointsEarned: number;
  newBalance: number;
  status: LoyaltyTxStatus;
  idempotencyKey: string;
}

export interface RedeemPointsRequest {
  organizationEndUserId: string;
  pointsAmount: number;
  idempotencyKey: string;
  receiptReference?: string;
  metadata?: Record<string, unknown>;
}

export interface RedeemPointsResponse {
  transactionId: string;
  organizationEndUserId: string;
  pointsRedeemed: number;
  newBalance: number;
  status: LoyaltyTxStatus;
  idempotencyKey: string;
}

export interface CreditBalanceSnapshot {
  organizationEndUserId: string;
  confirmedBalance: number;
  pendingEarn: number;
  pendingRedemption: number;
  lifetimeEarned: number;
  lifetimeRedeemed: number;
  asOfCheckpoint?: string | null;
}

export interface LoyaltyTransactionDto {
  id: string;
  organizationId: string;
  organizationEndUserId: string;
  createdByMembershipId?: string | null;
  blockchainTransactionId?: string | null;
  /** The Sui transaction digest, once `blockchainTransactionId` resolves on-chain. */
  blockchainDigest?: string | null;
  transactionType: LoyaltyTxType;
  pointsAmount: number;
  idempotencyKey: string;
  receiptReference?: string | null;
  status: LoyaltyTxStatus;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

