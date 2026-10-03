import { Controller } from '@nestjs/common';
import { RewardsService } from '../../domain/rewards/rewards.service.js';
/** REST boundary for rewards; no route methods or DTOs are implemented. */
@Controller()
export class RewardsController {
  constructor(private readonly service: RewardsService) {}
}
