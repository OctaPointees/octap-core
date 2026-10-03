import { Controller } from '@nestjs/common';
import { CampaignsService } from '../../domain/campaigns/campaigns.service.js';
/** REST boundary for campaigns; no route methods or DTOs are implemented. */
@Controller()
export class CampaignsController {
  constructor(private readonly service: CampaignsService) {}
}
