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
  /** Purchase amount in the program currency minor unit; the chain applies earn_bps. */
  purchaseAmount: number;
  idempotencyKey: string;
  receiptReference?: string;
  metadata?: Record<string, unknown>;
}

export interface EarnPointsResponse {
  transactionId: string;
  organizationEndUserId: string;
  purchaseAmount: number | null;
  /** Estimate at acceptance, never spendable before chain confirmation. */
  estimatedPoints: number | null;
  /** Actual chain-confirmed points, null while pending or failed. */
  pointsEarned: number | null;
  newBalance: number;
  status: LoyaltyTxStatus;
  idempotencyKey: string;
}

export interface ReservePosRedemptionRequest {
  organizationEndUserId: string;
  pointsAmount: number;
  idempotencyKey: string;
}

export interface ReservePosRedemptionResponse {
  transactionId: string;
  /** Null only when `status` isn't PENDING — the command already settled on an earlier call. */
  digest: string | null;
  /** Base64 full transaction bytes for the member's device to sign. Null alongside `digest`. */
  transactionBytes: string | null;
  status: LoyaltyTxStatus;
  idempotencyKey: string;
}

export interface FinalizePosRedemptionRequest {
  digest: string;
  signature: string;
}

export interface FinalizePosRedemptionResponse {
  transactionId: string;
  organizationEndUserId: string;
  pointsRedeemed: number;
  newBalance: number;
  status: LoyaltyTxStatus;
  blockchainDigest: string;
}

export interface CreditBalanceSnapshot {
  organizationEndUserId: string;
  confirmedBalance: number;
  pendingEarn: number;
  pendingRedemption: number;
  lifetimeEarned: number;
  lifetimeRedeemed: number;
  /** Last Sui checkpoint the indexer has projected; null until the indexer has seen any event. */
  asOfCheckpoint: string | null;
  /** When this snapshot was read (ISO 8601). */
  observedAt: string;
  /** True while `pendingEarn`/`pendingRedemption` is nonzero: part of this balance can still change. */
  stale: boolean;
}

export interface ReverseTransactionRequest {
  transactionId: string;
  idempotencyKey: string;
  reason: string;
}

export interface ReverseTransactionResponse {
  reversalTransactionId: string;
  reversedTransactionId: string;
  organizationEndUserId: string;
  pointsAmount: number;
  newBalance: number;
  /** True when `newBalance` went negative — the member owes points back (clawback debt). */
  balanceWentNegative: boolean;
  idempotencyKey: string;
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
  /** Actual points; null for an unconfirmed earn. */
  pointsAmount: number | null;
  purchaseAmount?: number | null;
  estimatedPoints?: number | null;
  idempotencyKey: string;
  receiptReference?: string | null;
  status: LoyaltyTxStatus;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}
