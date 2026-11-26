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

/** How much of each limit is in use. `transactionsMonthly` counts the current license month. */
export interface LicenseUsage {
  periodStart: string;
  periodEnd: string;
  transactionsMonthly: number;
  members: number;
  apiKeys: number;
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
