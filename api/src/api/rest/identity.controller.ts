import { Controller } from '@nestjs/common';
import { IdentityService } from '../../domain/identity/identity.service.js';
/** REST boundary for identity; no route methods or DTOs are implemented. */
@Controller()
export class IdentityController {
  constructor(private readonly service: IdentityService) {}
}
