/** Draft boundary types from the knowledge base; wire schemas remain to be designed. */
export type Points = string; // Decimal u64 string; validation is not implemented.
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

/**
 * What the customer gets for the points: a discount on one of your orders. It is hashed into the
 * on-chain redemption the customer signs, so the chain records what each spend paid for.
 */
export interface PosRedemptionBenefit {
  /** Your own order id. Must hold no personal data. */
  orderReference: string;
  /** The discount on that order, in `currency`'s major units (e.g. 25000 for 25.000 VND). */
  discountAmount: number;
  /** ISO 4217 code, e.g. `VND`. */
  currency: string;
}

export interface ReservePosRedemptionRequest extends PosRedemptionBenefit {
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

export type BudgetWarningThreshold = 80 | 95;

export interface IssuanceBudgetShard {
  shardId: string;
  remaining: number;
}

export interface IssuanceBudgetTopUp {
  operationId: string;
  amount: number;
  /** PENDING or PROCESSING until the chain answers; UNKNOWN needs an operator and is never retried. */
  status: string;
  createdAt: string;
}

/** How many more points a program may issue. Points, not money: no payment is involved. */
export interface IssuanceBudgetDto {
  organizationId: string;
  /** Live from the chain. Earns still in flight are not subtracted yet. */
  remaining: number;
  /** The figure set at provisioning, before any top-up. */
  initialBudget: number;
  /** `initialBudget` plus every applied top-up. */
  capacity: number;
  /** 80 or 95 once the fullest shard has used that percentage of its share, otherwise null. */
  warningThreshold: BudgetWarningThreshold | null;
  /** A shard never borrows from another, so an earn can fail while the total is above zero. */
  shards: IssuanceBudgetShard[];
  /** Latest first, at most 20. */
  recentTopUps: IssuanceBudgetTopUp[];
  observedAt: string;
}
