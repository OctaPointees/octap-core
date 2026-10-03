import { Controller } from '@nestjs/common';
import { AdministrationService } from '../../domain/administration/administration.service.js';
/** REST boundary for administration; no route methods or DTOs are implemented. */
@Controller()
export class AdministrationController {
  constructor(private readonly service: AdministrationService) {}
}
