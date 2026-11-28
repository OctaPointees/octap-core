import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import type { CampaignDto } from '@octap/contracts';
import { CampaignsService } from '#domain/rewards/campaigns.service.js';
import { Scopes } from '#infra/auth/scopes.decorator.js';
import { Tenant } from '#infra/auth/tenant.decorator.js';
import type { TenantContext } from '#infra/auth/tenant-context.js';

/**
 * Campaigns with a merchant API key (OCT-340), read only: a POS lists the live ones
 * (`?live=true`) and sends the cashier's pick as `campaignId` on an earn. Owners create and approve
 * campaigns in the console (`ConsoleCampaignsController`).
 */
@Controller('v1/campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get()
  @Scopes('read')
  list(@Tenant() tenant: TenantContext, @Query('live') live?: 'true' | 'false'): Promise<CampaignDto[]> {
    return this.campaigns.list(tenant.organizationId, live);
  }

  @Get(':campaignId')
  @Scopes('read')
  get(
    @Tenant() tenant: TenantContext,
    @Param('campaignId', new ParseUUIDPipe()) campaignId: string,
  ): Promise<CampaignDto> {
    return this.campaigns.get(tenant.organizationId, campaignId);
  }
}
