import { Injectable } from '@nestjs/common';
import { ExpiryProcessor } from './expiry.processor.js';
/** Scaffold: expiry job lifecycle. No consumer, timer, retry or execution. */
@Injectable()
export class ExpiryWorker {
  constructor(private readonly processor: ExpiryProcessor) {}
}
