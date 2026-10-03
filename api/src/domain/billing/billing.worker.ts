import { Injectable } from '@nestjs/common';
import { BillingProcessor } from './billing.processor.js';
/** Scaffold: billing job lifecycle. No consumer, timer, retry or execution. */
@Injectable()
export class BillingWorker {
  constructor(private readonly processor: BillingProcessor) {}
}
