import { Controller } from '@nestjs/common';
import { CreditsService } from '../../domain/credits/credits.service.js';
/** REST boundary for credits; no route methods or DTOs are implemented. */
@Controller()
export class CreditsController {
  constructor(private readonly service: CreditsService) {}
}
