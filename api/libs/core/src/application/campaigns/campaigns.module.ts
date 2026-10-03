import { Module } from '@nestjs/common';
import { CampaignsService } from './campaigns.service.js';
@Module({ providers: [CampaignsService], exports: [CampaignsService] })
export class CampaignsModule {}
