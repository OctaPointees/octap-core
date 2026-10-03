import { Controller } from '@nestjs/common';
import { PoliciesService } from '../../domain/policies/policies.service.js';
/** REST boundary for policies; no route methods or DTOs are implemented. */
@Controller()
export class PoliciesController {
  constructor(private readonly service: PoliciesService) {}
}
