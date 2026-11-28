import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import { UUID_PATTERN } from '#infra/db/repositories/console-access.js';
import type { CampaignsRepository } from '#infra/db/repositories/campaigns.repository.js';

/** `multiplier_bps` of an ordinary earn (1x), as `credit_account::earn` takes it. */
export const BASE_MULTIPLIER_BPS = 10_000;

export interface CampaignBoost {
  campaignId: string | null;
  multiplierBps: number;
}

/**
 * The boost an earn naming `campaignId` gets (OCT-340). No campaign is an ordinary earn (1x). A
 * campaign that is not this organization's, not ACTIVE, outside its `[startsAt, endsAt]` window, or
 * without a multiplier is a 422: the earn is refused, never earned at the base rate instead, which
 * would hide a broken POS integration. Shared with the sandbox, so both boost the same way.
 */
export async function campaignBoost(
  repo: Pick<CampaignsRepository, 'find'>,
  organizationId: string,
  campaignId: unknown,
  now: Date = new Date(),
): Promise<CampaignBoost> {
  if (campaignId === undefined) return { campaignId: null, multiplierBps: BASE_MULTIPLIER_BPS };
  if (typeof campaignId !== 'string' || !UUID_PATTERN.test(campaignId)) {
    throw new BadRequestException('campaignId must be a campaign id');
  }
  const campaign = await repo.find(organizationId, campaignId);
  if (!campaign) throw new UnprocessableEntityException(`Campaign ${campaignId} was not found for this organization`);
  if (campaign.status !== 'ACTIVE') {
    throw new UnprocessableEntityException(`Campaign ${campaignId} is ${campaign.status}, not ACTIVE`);
  }
  if (now < campaign.startsAt) {
    throw new UnprocessableEntityException(`Campaign ${campaignId} starts at ${campaign.startsAt.toISOString()}`);
  }
  if (now > campaign.endsAt) {
    throw new UnprocessableEntityException(`Campaign ${campaignId} ended at ${campaign.endsAt.toISOString()}`);
  }
  if (campaign.multiplierBps === null) {
    throw new UnprocessableEntityException(`Campaign ${campaignId} boosts no earn; it only groups vouchers`);
  }
  return { campaignId, multiplierBps: campaign.multiplierBps };
}
