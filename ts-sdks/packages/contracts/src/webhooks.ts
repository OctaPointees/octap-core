import type { RedeemVoucherResponse } from './rewards.js';

export type WebhookEndpointStatus = 'ACTIVE' | 'DISABLED';
export type WebhookDeliveryStatus = 'PENDING' | 'DELIVERED' | 'DEAD_LETTER';

export interface WebhookEndpointDto {
  id: string;
  organizationId: string;
  url: string;
  description?: string | null;
  status: WebhookEndpointStatus;
  createdAt: string;
  updatedAt: string;
}

/** Only ever returned on register/rotate — the secret is never included in a list or get. */
export interface WebhookEndpointWithSecretDto extends WebhookEndpointDto {
  secret: string;
}

export interface RegisterWebhookEndpointRequest {
  url: string;
  description?: string;
}

export interface WebhookDeliveryDto {
  id: string;
  endpointId: string;
  eventType: string;
  status: WebhookDeliveryStatus;
  attemptCount: number;
  nextAttemptAt: string;
  lastResponseStatus?: number | null;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Every event OctaP delivers; sent as `x-octap-event-type` and as the body's `type`. */
export type WebhookEventType =
  | 'credits.earned'
  | 'credits.earn.confirmed'
  | 'credits.redemption.confirmed'
  | 'credits.reversed'
  | 'voucher.redeemed';

/**
 * `credits.earned`: an earn was *accepted* and is on its way to the chain (status PENDING).
 * `newBalance` is the confirmed balance, which does not include it yet; wait for
 * `credits.earn.confirmed` before treating the points as spendable.
 */
export interface CreditsEarnedEventData {
  transactionId: string;
  organizationEndUserId: string;
  purchaseAmount: number;
  estimatedPoints: number;
  newBalance: number;
}

/**
 * `credits.earn.confirmed` / `credits.redemption.confirmed`: the chain confirmed the transaction.
 * Sent exactly once per transaction, however it was confirmed (the submitting worker, POS
 * finalize, or the indexer catching up).
 */
export interface CreditsChainConfirmedEventData {
  transactionId: string;
  organizationEndUserId: string;
  /** For an earn, the amount actually credited on-chain, not the requested purchase amount. */
  pointsAmount: number;
  /** The confirmed balance right after this transaction. */
  newBalance: number;
  blockchainDigest: string;
}

/**
 * `credits.reversed`: a CONFIRMED earn or redemption was reversed in the ledger. Settled
 * immediately; a chain-confirmed original is also mirrored on-chain afterwards, which sends no
 * separate event.
 */
export interface ReversalEventData {
  reversalTransactionId: string;
  reversedTransactionId: string;
  organizationEndUserId: string;
  pointsAmount: number;
  newBalance: number;
  /** True when reversing an already-spent earn left a clawback debt. */
  balanceWentNegative: boolean;
}

/**
 * `voucher.redeemed`: a claimed voucher instance was used at checkout (marked REDEEMED). No points
 * move here; a paid claim already sent `credits.redemption.confirmed` for its points cost.
 */
export interface VoucherRedeemedEventData extends RedeemVoucherResponse {
  organizationEndUserId: string;
}

interface WebhookEventOf<T extends WebhookEventType, D> {
  /** Stable across retries and replays (`x-octap-event-id`): dedupe on it. */
  id: string;
  type: T;
  data: D;
}

/** A delivered webhook body, discriminated on `type`. */
export type WebhookEvent =
  | WebhookEventOf<'credits.earned', CreditsEarnedEventData>
  | WebhookEventOf<'credits.earn.confirmed', CreditsChainConfirmedEventData>
  | WebhookEventOf<'credits.redemption.confirmed', CreditsChainConfirmedEventData>
  | WebhookEventOf<'credits.reversed', ReversalEventData>
  | WebhookEventOf<'voucher.redeemed', VoucherRedeemedEventData>;
