import { Injectable } from '@nestjs/common';
import { BillingService } from './billing.service.js';
/** Scaffold: coordinate a single billing job. No job handling is implemented. */
@Injectable()
export class BillingProcessor {
  constructor(private readonly service: BillingService) {}
}
