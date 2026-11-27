/**
 * Licenses (OCT-329): what an organization may use, and until when. A license plan is a tier in the
 * catalogue the System Admin manages; a license is one organization's copy of a plan's
 * entitlements for a period. Billing never touches customers' points or vouchers.
 */

export type LicenseTier = 'TRIAL' | 'STARTER' | 'GROWTH' | 'ENTERPRISE';
export const LICENSE_TIERS: readonly LicenseTier[] = ['TRIAL', 'STARTER', 'GROWTH', 'ENTERPRISE'];

/**
 * Features a plan switches on. `core` (earn, redeem, vouchers, members, console) is never listed:
 * every license has it.
 */
export type LicenseFeature = 'voucher.batches' | 'voucher.approval' | 'webhooks' | 'mcp' | 'assistant' | 'sandbox';
export const LICENSE_FEATURES: readonly LicenseFeature[] = [
  'voucher.batches',
  'voucher.approval',
  'webhooks',
  'mcp',
  'assistant',
  'sandbox',
];

/** Caps a plan sets. `null` is no limit. */
export interface LicenseLimits {
  /** Confirmed earns and redeems per license month. */
  transactionsMonthly: number | null;
  /** The organization's members (customers). */
  members: number | null;
  /** ACTIVE API keys. Core's own cap of 25 still applies. */
  apiKeys: number | null;
  /** ACTIVE Owners and Business Developers. */
  teamMembers: number | null;
}
export const LICENSE_LIMIT_KEYS: readonly (keyof LicenseLimits)[] = [
  'transactionsMonthly',
  'members',
  'apiKeys',
  'teamMembers',
];

/** What a plan grants, copied onto each license when it is created. */
export interface LicenseEntitlements {
  features: LicenseFeature[];
  limits: LicenseLimits;
}

/** After `endsAt`, new transactions keep working for this many days, then the license is EXPIRED. */
export const LICENSE_GRACE_DAYS = 7;

/**
 * Worked out from the dates, never stored: ACTIVE before `endsAt`, GRACE for
 * `LICENSE_GRACE_DAYS` after it, EXPIRED from then on.
 */
export type LicenseState = 'ACTIVE' | 'GRACE' | 'EXPIRED';

/** How a license came about. */
export type LicenseSource = 'TRIAL' | 'MIGRATION' | 'PURCHASE' | 'ADMIN';

export interface LicensePlanDto {
  id: string;
  tier: LicenseTier;
  name: string;
  /** Price of one month, an integer in VND. An order costs this times the months bought. */
  monthlyPriceVnd: number;
  /** The terms, in months, it can be bought for; empty when it isn't bought by the month. */
  termMonthsAllowed: number[];
  /** A fixed length in days instead of months (the trial). */
  durationDays: number | null;
  entitlements: LicenseEntitlements;
  /** Offered to Owners to buy. A plan that isn't (the trial, a contract) is still granted. */
  purchasable: boolean;
  /** Inactive plans are kept for the licenses already on them but are no longer offered. */
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LicenseDto {
  id: string;
  organizationId: string;
  planId: string;
  tier: LicenseTier;
  planName: string;
  /** The plan's entitlements as they were when this license was created. */
  entitlements: LicenseEntitlements;
  source: LicenseSource;
  startsAt: string;
  endsAt: string;
  graceEndsAt: string;
  state: LicenseState;
  /** Whole days until `endsAt`, 0 once it has passed. */
  daysLeft: number;
}

/**
 * How much of each limit is in use. `transactionsMonthly` counts the current license month, which
 * runs from `periodStart` to `periodEnd`; the last month ends at the license's `endsAt`, and once that
 * has passed it stays the last month.
 */
export interface LicenseUsage {
  periodStart: string;
  periodEnd: string;
  transactionsMonthly: number;
  /** ACTIVE members who aren't blocked or unverified. */
  members: number;
  /** ACTIVE API keys, sandbox ones included. */
  apiKeys: number;
  /** ACTIVE Owners and Business Developers. */
  teamMembers: number;
}

/** `GET …/license`: the organization's current license and usage; `null` when it has none. */
export interface OrganizationLicenseDto {
  organizationId: string;
  license: LicenseDto | null;
  usage: LicenseUsage | null;
}

/** `POST /v1/platform/license-plans`. */
export interface CreateLicensePlanRequest {
  tier: LicenseTier;
  name: string;
  monthlyPriceVnd: number;
  termMonthsAllowed?: number[];
  durationDays?: number | null;
  entitlements: LicenseEntitlements;
  purchasable?: boolean;
  active?: boolean;
}

/**
 * `PATCH /v1/platform/license-plans/:id`. Licenses already granted keep their own copy. A named
 * interface, not `Partial<Omit<…>>`: the OpenAPI generator names an inline generic after the file's
 * absolute path.
 */
export interface UpdateLicensePlanRequest {
  name?: string;
  monthlyPriceVnd?: number;
  termMonthsAllowed?: number[];
  durationDays?: number | null;
  entitlements?: LicenseEntitlements;
  purchasable?: boolean;
  active?: boolean;
}

/**
 * Why a request was refused with 402 (OCT-329): the license doesn't include the feature, or the
 * organization has used up a limit. 403 stays for "not allowed whatever the plan".
 */
/**
 * Why a 402 refused the request. `LICENSE_EXPIRED`: the license is past its grace period, so new
 * transactions (earn, POS reserve, paid voucher claims) are refused until it is renewed.
 */
export type LicenseErrorCode = 'LICENSE_FEATURE_NOT_INCLUDED' | 'LICENSE_LIMIT_REACHED' | 'LICENSE_EXPIRED';

/** The body of a 402. `feature` or `limit` says which; `used` and `allowed` come with a limit. */
export interface LicenseErrorBody {
  statusCode: 402;
  code: LicenseErrorCode;
  message: string;
  feature?: LicenseFeature;
  limit?: keyof LicenseLimits;
  used?: number;
  allowed?: number;
}

/**
 * New transactions are refused once a license month's count reaches this share of
 * `transactionsMonthly`: the 10% above the limit gives the partner time to upgrade or renew.
 */
export const LICENSE_TRANSACTION_HARD_LIMIT_PERCENT = 110;

/** The shares of `transactionsMonthly` that send a warning, once each per license month. */
export type LicenseUsageThreshold = 80 | 100;
export const LICENSE_USAGE_THRESHOLDS: readonly LicenseUsageThreshold[] = [80, 100];

/** `license.usage_threshold`: this license month's transactions reached 80% or 100% of the limit. */
export interface LicenseUsageThresholdEventData {
  limit: 'transactionsMonthly';
  threshold: LicenseUsageThreshold;
  used: number;
  /** The plan's `transactionsMonthly`. New transactions stop at 110% of it. */
  allowed: number;
  periodStart: string;
  periodEnd: string;
}

/** Days before `endsAt` that send a reminder, latest first. */
export const LICENSE_EXPIRY_REMINDER_DAYS = [30, 7, 1] as const;

/**
 * A step of a license's end, in order: reminders before `endsAt`, then `GRACE` once it has passed
 * (still working), then `EXPIRED` once the grace period is over (new transactions refused).
 */
export type LicenseExpiryStage = 'DAYS_30' | 'DAYS_7' | 'DAYS_1' | 'GRACE' | 'EXPIRED';
export const LICENSE_EXPIRY_STAGES: readonly LicenseExpiryStage[] = ['DAYS_30', 'DAYS_7', 'DAYS_1', 'GRACE', 'EXPIRED'];

/**
 * `license.expiry_notice`: the organization's license reached a step of its end. Sent once per step,
 * and only for the latest license, so a license already renewed sends nothing more. When several
 * steps passed unseen (no worker ran), only the current one is sent.
 */
export interface LicenseExpiryNoticeEventData {
  licenseId: string;
  stage: LicenseExpiryStage;
  tier: LicenseTier;
  planName: string;
  endsAt: string;
  graceEndsAt: string;
  /** Whole days until `endsAt`, 0 once it has passed. */
  daysLeft: number;
}

/**
 * `POST /v1/platform/organizations/:organizationId/license`, System Admin: grants `months` of
 * `planId`. It follows the current license (from its `endsAt`) while that is active or in grace,
 * and starts now once it has expired or when there is none.
 */
export interface RenewLicenseRequest {
  planId: string;
  months: number;
}

/**
 * An order to buy or renew a license (OCT-330), paid by bank transfer. `PAID` once the money
 * arrived, `CANCELED` when the Owner dropped it or chose another plan. `EXPIRED` is never stored:
 * it is a `PENDING` order past `expiresAt`, and a transfer for it is no longer accepted.
 */
export type LicenseOrderStatus = 'PENDING' | 'PAID' | 'CANCELED';
export type LicenseOrderState = LicenseOrderStatus | 'EXPIRED';

/** How long an order can be paid. */
export const LICENSE_ORDER_TTL_HOURS = 24;

/** Every payment code starts with this, then 8 digits; SePay finds it in the transfer content. */
export const LICENSE_PAYMENT_CODE_PREFIX = 'OCTAP';

/** `POST /v1/console/organizations/:organizationId/license/orders`, Owner only. */
export interface CreateLicenseOrderRequest {
  planId: string;
  /** One of the plan's `termMonthsAllowed`. */
  termMonths: number;
}

/** An order and how to pay it. The amount is always the plan's monthly price times the term. */
export interface LicenseOrderDto {
  id: string;
  organizationId: string;
  planId: string;
  tier: LicenseTier;
  planName: string;
  termMonths: number;
  amountVnd: number;
  /** Put it in the transfer content as is: that is how the payment is matched to this order. */
  paymentCode: string;
  state: LicenseOrderState;
  /** VietQR image for exactly `amountVnd`, with `paymentCode` as the transfer content. */
  qrUrl: string;
  bankAccount: string;
  bankCode: string;
  expiresAt: string;
  paidAt: string | null;
  createdAt: string;
}
