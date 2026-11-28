import type { LicenseExpiryNoticeEventData, LicenseUsageThresholdEventData } from './licensing.js';
import type { BudgetWarningThreshold } from './loyalty.js';
import type {
  RedeemVoucherResponse,
  VoucherActorRef,
  VoucherOwnershipStatus,
  VoucherPublishStatus,
  VoucherStatus,
} from './rewards.js';

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
  /** This delivery (to replay it). Not the event's id: one event goes to every endpoint. */
  id: string;
  /** The event delivered, sent as the body's `id` and `x-octap-event-id`. */
  eventId: string;
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
  | 'credits.earn.failed'
  | 'credits.redemption.confirmed'
  | 'credits.reversed'
  | 'voucher.granted'
  | 'voucher.redeemed'
  | 'voucher.created'
  | 'voucher.submitted'
  | 'voucher.returned'
  | 'voucher.activated'
  | 'voucher.publish.failed'
  | 'voucher.paused'
  | 'voucher.archived'
  | 'voucher.expired'
  | 'voucher.member_expired'
  | 'budget.low'
  | 'license.usage_threshold'
  | 'license.expiry_notice'
  | 'webhook.test';

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
  /** The campaign whose multiplier boosted it (OCT-340); absent for an ordinary earn. */
  campaignId?: string;
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
  /**
   * Only on `credits.redemption.confirmed` for a paid voucher claim: the voucher it bought, now
   * AVAILABLE, with its final `expiresAt` counted from the chain's issue time. The claim response's
   * `expiresAt` was provisional.
   */
  voucher?: { voucherOwnershipId: string; expiresAt: string | null };
}

export type EarnFailureCode = 'BUDGET_EXHAUSTED' | 'REJECTED';

/**
 * `credits.earn.failed`: an accepted earn definitely failed. Its hold was released and nothing was
 * credited. Its key stays used, so a new attempt needs a new key.
 */
export interface CreditsEarnFailedEventData {
  transactionId: string;
  organizationEndUserId: string;
  purchaseAmount: number | null;
  estimatedPoints: number;
  failureCode: EarnFailureCode;
}

/**
 * `budget.low`: the fullest budget shard crossed a threshold. Sent once per crossing; a top-up that
 * brings usage back below it lets it fire again. Checked periodically, not on each earn.
 */
export interface BudgetLowEventData {
  threshold: BudgetWarningThreshold;
  remaining: number;
  capacity: number;
}

/**
 * `webhook.test`: sent on request from the console to one endpoint only, to check that it receives
 * and verifies OctaP's deliveries. Signed and retried like any other event. Nothing happened in
 * the organization: ignore it beyond acknowledging it.
 */
export interface WebhookTestEventData {
  endpointId: string;
  message: string;
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
}

/**
 * `voucher.granted`: the chain recorded a voucher given without spending points, through a grant or
 * a free claim. A paid claim reports through `credits.redemption.confirmed` instead.
 */
export interface VoucherGrantedEventData {
  voucherOwnershipId: string;
  voucherId: string;
  organizationEndUserId: string;
  serialCode: string;
  status: VoucherOwnershipStatus;
  /**
   * This customer's final use deadline, counted from the chain's issue time; `null` never expires.
   * The grant response's `expiresAt` was provisional.
   */
  expiresAt: string | null;
  blockchainDigest: string;
}

/**
 * `voucher.member_expired`: a customer's voucher reached its own deadline (`expiresAt`) unused, so it
 * is `EXPIRED` and can no longer be used. Sent once, within about a minute of the deadline (the
 * expiry sweep), or sooner when the voucher is read first.
 */
export interface VoucherMemberExpiredEventData {
  voucherOwnershipId: string;
  voucherId: string;
  organizationEndUserId: string;
  serialCode: string;
  status: VoucherOwnershipStatus;
  expiresAt: string | null;
}

/**
 * `voucher.redeemed`: the customer signed and the chain marked their voucher used. Deliver the benefit
 * on this event. No points move here; a paid claim already sent `credits.redemption.confirmed`.
 */
export interface VoucherRedeemedEventData extends RedeemVoucherResponse {
  organizationEndUserId: string;
}

/**
 * The voucher as it is right after the change. Every voucher lifecycle event carries it: fetch the
 * voucher for anything else. `updatedAt` is the value an Owner's activation or review sends back.
 *
 * - `voucher.created`: created on its own or by a batch, or an archived code imported again (back as
 *   `DRAFT` in the new batch). Created with `status: 'ACTIVE'` it is followed by `voucher.submitted`,
 *   or by `voucher.activated` once the chain holds its terms.
 * - `voucher.activated`: it is `ACTIVE` and claimable: the chain confirmed its terms, or a paused one
 *   was resumed. Not sent while publishing; one paused while publishing waits until it is resumed.
 * - `voucher.publish.failed`: its terms never reached the chain (`publishStatus: 'FAILED'`). Fix it and
 *   activate it again.
 * - `voucher.paused`: an Owner or an API key paused it; claims stop.
 * - `voucher.archived`: its batch was archived before it went live; it can no longer be used.
 * - `voucher.expired`: its claim window (`expiresAt`) closed while it was live, paused or sold out, so
 *   it is `EXPIRED` and nobody can claim it any more. Vouchers customers already hold keep their own
 *   deadline (`voucher.member_expired`).
 */
export interface VoucherLifecycleEventData {
  voucherId: string;
  code: string;
  title: string;
  batchId: string | null;
  status: VoucherStatus;
  publishStatus: VoucherPublishStatus;
  /** The on-chain `VoucherTerms`, once published. */
  suiTermsId: string | null;
  createdBy: VoucherActorRef;
  activatedBy: VoucherActorRef;
  activatedAt: string | null;
  updatedAt: string;
}

/**
 * `voucher.submitted`: a Business Developer's (or an API key's) activation is waiting for an Owner,
 * because the organization requires approval. Status `PENDING_APPROVAL`.
 */
export interface VoucherSubmittedEventData extends VoucherLifecycleEventData {
  /** The submission an Owner approves or rejects. */
  approvalRequestId: string;
  submittedBy: VoucherActorRef;
}

/**
 * `voucher.returned`: a submission left the approval queue without going live: an Owner rejected it
 * (`reason` says why) or it was withdrawn. The voucher is back to `DRAFT`. An approval sends no
 * `voucher.returned`; it starts publishing, and `voucher.activated` follows.
 */
export interface VoucherReturnedEventData extends VoucherLifecycleEventData {
  approvalRequestId: string;
  outcome: 'REJECTED' | 'WITHDRAWN';
  reason: string | null;
  /** The user who rejected or withdrew it. */
  reviewedById: string | null;
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
  | WebhookEventOf<'credits.earn.failed', CreditsEarnFailedEventData>
  | WebhookEventOf<'credits.redemption.confirmed', CreditsChainConfirmedEventData>
  | WebhookEventOf<'credits.reversed', ReversalEventData>
  | WebhookEventOf<'voucher.granted', VoucherGrantedEventData>
  | WebhookEventOf<'voucher.redeemed', VoucherRedeemedEventData>
  | WebhookEventOf<'voucher.created', VoucherLifecycleEventData>
  | WebhookEventOf<'voucher.submitted', VoucherSubmittedEventData>
  | WebhookEventOf<'voucher.returned', VoucherReturnedEventData>
  | WebhookEventOf<'voucher.activated', VoucherLifecycleEventData>
  | WebhookEventOf<'voucher.publish.failed', VoucherLifecycleEventData>
  | WebhookEventOf<'voucher.paused', VoucherLifecycleEventData>
  | WebhookEventOf<'voucher.archived', VoucherLifecycleEventData>
  | WebhookEventOf<'voucher.expired', VoucherLifecycleEventData>
  | WebhookEventOf<'voucher.member_expired', VoucherMemberExpiredEventData>
  | WebhookEventOf<'budget.low', BudgetLowEventData>
  | WebhookEventOf<'license.usage_threshold', LicenseUsageThresholdEventData>
  | WebhookEventOf<'license.expiry_notice', LicenseExpiryNoticeEventData>
  | WebhookEventOf<'webhook.test', WebhookTestEventData>;

/** The `data` of each event type. */
export type WebhookEventData<T extends WebhookEventType> = Extract<WebhookEvent, { type: T }>['data'];
