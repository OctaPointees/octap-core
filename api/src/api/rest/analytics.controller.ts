import { Controller } from '@nestjs/common';
import { AnalyticsService } from '../../domain/analytics/analytics.service.js';
/** REST boundary for analytics; no route methods or DTOs are implemented. */
@Controller()
export class AnalyticsController {
  constructor(private readonly service: AnalyticsService) {}
}
