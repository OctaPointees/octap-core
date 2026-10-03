import { Controller } from '@nestjs/common';
import { DeveloperService } from '../../domain/developer/developer.service.js';
/** REST boundary for developer; no route methods or DTOs are implemented. */
@Controller()
export class DeveloperController {
  constructor(private readonly service: DeveloperService) {}
}
