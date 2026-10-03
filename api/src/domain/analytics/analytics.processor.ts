import { Injectable } from '@nestjs/common';
import { AnalyticsService } from './analytics.service.js';
/** Scaffold: coordinate a single analytics job. No job handling is implemented. */
@Injectable()
export class AnalyticsProcessor {
  constructor(private readonly service: AnalyticsService) {}
}
