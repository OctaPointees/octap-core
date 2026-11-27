/**
 * How an organization's points and vouchers actually moved, for its Owner and Business
 * Developers: `GET /v1/console/organizations/{organizationId}/analytics/summary`. Every figure
 * here is CONFIRMED-only and answers one operating question; nothing is shown just because the
 * data exists. Cross-organization figures (how many merchants OctaP has, platform revenue) are
 * out of scope here — revenue specifically has nothing real behind it yet, since billing is not a
 * live payment flow.
 */
export interface ProgramAnalyticsQuery {
  /** ISO 8601 date-time with an offset or Z. Defaults to 30 days before `to`; at most 366 days before it. */
  from?: string;
  /** ISO 8601 date-time with an offset or Z. Defaults to now. */
  to?: string;
}

/** The program's point economy in the window. `earned`/`redeemed`/`reversed` are unsigned magnitudes. */
export interface ProgramCirculation {
  /** Points actually granted (CONFIRMED EARN). The liability side: what the organization now owes its customers. */
  earned: number;
  /** Points actually spent (CONFIRMED REDEEM). The proof side: evidence the points are used, not just handed out. */
  redeemed: number;
  /** Points undone because a merchant corrected a mistake (CONFIRMED REVERSAL of an earn or of a redemption). High relative to `earned` flags an issuance quality problem, not a healthy program. */
  reversed: number;
  /** How much the outstanding balance grew this window: `earned - redeemed`, minus reversed earns, plus reversed redemptions (their points go back to the customer). A number that only ever grows means the program is a one-way liability with no redemption behind it. */
  net: number;
}

/** Whether enrollment is converting into actual use, not just sign-ups. */
export interface ProgramEngagement {
  /** Distinct customers with at least one CONFIRMED earn or redeem in the window — people actually using the program now. */
  activeMembers: number;
  /** Everyone ever enrolled in this organization, regardless of the window. Compare to `activeMembers`: a wide gap means enrollment isn't converting to use. */
  enrolledMembers: number;
}

/** Whether issued vouchers get used, not just claimed and forgotten. */
export interface VoucherPerformance {
  /** Vouchers a customer claimed in the window (points spent or a free one taken). */
  claimed: number;
  /** Of all vouchers redeemed at the merchant in the window — the only number here that proves the voucher did its job. */
  redeemed: number;
  /** Claimed vouchers whose `expiresAt` passed unused in the window (up to now): lost value for the customer and wasted issuance budget for the merchant. */
  expiredUnused: number;
}

/** One day's earn/redeem totals — the trend behind `circulation`, for a chart. */
export interface ProgramAnalyticsDay {
  /** Start of the day (UTC midnight), ISO 8601. The first and last day count only what falls inside the window. */
  start: string;
  earned: number;
  redeemed: number;
}

export interface ProgramAnalyticsSummary {
  from: string;
  to: string;
  circulation: ProgramCirculation;
  engagement: ProgramEngagement;
  vouchers: VoucherPerformance;
  dailyTrend: ProgramAnalyticsDay[];
}
