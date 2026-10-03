import { Controller } from '@nestjs/common';
import { BillingService } from '../../domain/billing/billing.service.js';
/** REST boundary for billing; no route methods or DTOs are implemented. */
@Controller()
export class BillingController {
  constructor(private readonly service: BillingService) {}
}
