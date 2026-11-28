import type { VoucherBatchActionResult, VoucherDto } from './rewards.js';

/**
 * DRAFT until an Owner activates it, which approves it. ACTIVE and PAUSED move back and forth;
 * ENDED (by the Owner, or automatically once `endsAt` has passed) and ARCHIVED are final.
 */
export type CampaignStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ENDED' | 'ARCHIVED';

/** The most an earn may be boosted: 10x, enforced on-chain too. */
export const CAMPAIGN_MAX_MULTIPLIER_BPS = 100_000;
export const CAMPAIGN_MAX_NAME_LENGTH = 160;
export const CAMPAIGN_MAX_DESCRIPTION_LENGTH = 2000;

/**
 * A named, time-boxed promotion (OCT-340). It may boost earn, group vouchers, or both:
 * - Earn: an earn that sends this campaign's id as `campaignId` gets `multiplierBps` on top of the
 *   program's rate, while the campaign is ACTIVE and `startsAt <= now <= endsAt`. Otherwise the earn is
 *   refused (422), never earned at the base rate instead.
 * - Vouchers: a voucher created with `campaignId`, alone or in a batch, belongs to it.
 */
export interface CampaignDto {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  status: CampaignStatus;
  startsAt: string;
  endsAt: string;
  /** 20000 is 2x. `null`: the campaign boosts no earn, it only groups vouchers. */
  multiplierBps: number | null;
  /** Whether an earn naming it is boosted right now: ACTIVE, within its window, with a multiplier. */
  earnBoostLive: boolean;
  createdByUserId: string | null;
  /** The Owner whose first activation approved it. */
  approvedByUserId: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListCampaignsRequest {
  /** Only campaigns that boost an earn right now (`earnBoostLive`). Defaults to `false`. */
  live?: boolean;
}

/** A campaign with its vouchers, in `code` order. */
export interface CampaignDetailDto extends CampaignDto {
  vouchers: VoucherDto[];
}

/** Created as a DRAFT; nothing is boosted until an Owner activates it. */
export interface CreateCampaignRequest {
  name: string;
  description?: string | null;
  /** ISO 8601. */
  startsAt: string;
  /** ISO 8601, after `startsAt`. */
  endsAt: string;
  /**
   * The earn boost, above 10000 (1x) and at most `CAMPAIGN_MAX_MULTIPLIER_BPS` (10x). Omit or `null` for
   * a campaign that only groups vouchers.
   * @TJS-type ["integer", "null"]
   */
  multiplierBps?: number | null;
}

/** `activate`, `pause`, `resume` or `archive` on every voucher of a campaign, with each voucher's outcome. */
export interface CampaignVoucherActionResponse {
  campaign: CampaignDto;
  vouchers: VoucherBatchActionResult[];
}
