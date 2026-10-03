import { Injectable } from '@nestjs/common';
import { AnalyticsProcessor } from './analytics.processor.js';
/** Scaffold: analytics job lifecycle. No consumer, timer, retry or execution. */
@Injectable()
export class AnalyticsWorker {
  constructor(private readonly processor: AnalyticsProcessor) {}
}
