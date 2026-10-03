import { Module } from '@nestjs/common';
import { CampaignsService } from './campaigns.service.js';
import { CampaignApprovalService } from './campaign-approval.service.js';
@Module({ providers: [CampaignsService, CampaignApprovalService], exports: [CampaignsService, CampaignApprovalService] })
export class CampaignsModule {}
