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
  /** Present, and true, only on what a sandbox key made or reads (OCT-297). */
  isSandbox?: true;

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
  /** Present, and true, only on what a sandbox key made or reads (OCT-297). */
  isSandbox?: true;

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
  /** Present, and true, only on what a sandbox key made or reads (OCT-297). */
  isSandbox?: true;

  transactionId: string;
  organizationEndUserId: string;
  pointsRedeemed: number;
  newBalance: number;
  status: LoyaltyTxStatus;
  blockchainDigest: string;
}

export interface CreditBalanceSnapshot {
  /** Present, and true, only on what a sandbox key made or reads (OCT-297). */
  isSandbox?: true;

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
  /** The member's `CreditAccount` object on Sui; null until their first earn opens it. */
  creditAccountId: string | null;
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
  idempotencyKey: string;
}

export interface LoyaltyTransactionDto {
  /** Present, and true, only on what a sandbox key made or reads (OCT-297). */
  isSandbox?: true;

  id: string;
  organizationId: string;
  organizationEndUserId: string;
  createdByMembershipId?: string | null;
  blockchainTransactionId?: string | null;
  /** The Sui transaction digest, once `blockchainTransactionId` resolves on-chain. */
  blockchainDigest?: string | null;
  /** When the chain confirmed it; null until then. */
  confirmedAt?: string | null;
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

/** A page of a member's history, newest first. Pass `nextCursor` back as `cursor` for the next page. */
export interface LoyaltyTransactionPage {
  items: LoyaltyTransactionDto[];
  nextCursor: string | null;
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

/**
 * `GET /v1/credits/transactions` and `GET /v1/console/organizations/{organizationId}/transactions`:
 * the organization's points history, newest first. `limit` 1–100 (default 25), `cursor` from the
 * last page's `nextCursor`; `type`, `status` and `memberId` narrow it.
 */
export interface OrganizationTransactionQuery {
  limit?: number;
  cursor?: string;
  type?: LoyaltyTxType;
  status?: LoyaltyTxStatus;
  memberId?: string;
}

/**
 * How a member's recorded balance compares with their `CreditAccount` on Sui, read live from the
 * chain's own `credit_account::spendable`:
 * - `MATCH`: the two are equal.
 * - `PENDING`: something for this member is still on its way to the chain (a pending earn or
 *   redemption, or a reversal not yet mirrored), so they cannot be compared yet. Ask again shortly.
 * - `MISMATCH`: nothing is in flight and they differ.
 * - `UNAVAILABLE`: the chain could not be read just now.
 */
export type BalanceReconciliationStatus = 'MATCH' | 'PENDING' | 'MISMATCH' | 'UNAVAILABLE';

/** `GET …/members/{memberId}/reconciliation`. Cached for up to 30 seconds. */
export interface BalanceReconciliation {
  organizationEndUserId: string;
  status: BalanceReconciliationStatus;
  /** The member's `CreditAccount` object; null before their first earn (the ledger then holds 0). */
  creditAccountId: string | null;
  /** OctaP's `confirmedBalance`. */
  recordedBalance: number;
  /** What the chain says is spendable now; null when `UNAVAILABLE`. */
  ledgerBalance: number | null;
  /** `ledgerBalance - recordedBalance`; null when `UNAVAILABLE`. */
  difference: number | null;
  checkedAt: string;
}

/** The program's published rules as the chain holds them, beside what OctaP applies. */
export interface ProgramPolicyEvidence {
  policyVersionId: string;
  version: number;
  earnBps: number;
  expiryMs: number;
  /** The transaction that published the policy; null if the chain did not report one. */
  publishedDigest: string | null;
  publishedAt: string | null;
}

/**
 * `GET /v1/credits/program` and `GET /v1/console/organizations/{organizationId}/program`: the
 * loyalty program and the on-chain policy behind it. `policyStatus` is `MATCH` when the chain's
 * rules are the ones OctaP applies, `MISMATCH` otherwise, `UNAVAILABLE` when the chain could not be
 * read (then `policy` is null).
 */
export interface ProgramEvidence {
  programId: string;
  status: string;
  programControlId: string;
  earnBps: number;
  expiryMs: number;
  provisionedAt: string;
  policyStatus: 'MATCH' | 'MISMATCH' | 'UNAVAILABLE';
  policy: ProgramPolicyEvidence | null;
}
