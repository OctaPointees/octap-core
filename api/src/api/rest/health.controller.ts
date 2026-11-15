import { Controller, Get, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { Public } from '#infra/auth/public.decorator.js';
import { HealthService } from '#observability/health.service.js';
import { ConsoleAccessGuard, PlatformAdminOnly } from './console-access.guard.js';

/**
 * Deep health check for load balancers and uptime monitors: database, Redis and Sui RPC
 * reachability, not just "the process is up". 503 when the database or Redis is down; Sui alone
 * down is `degraded` with 200 (see `HealthStatus`). Unauthenticated, so statuses only.
 *
 * No `PublicRateLimitGuard`, deliberately: `HealthService.publicReport` already bounds the load
 * (one probe per 5s, shared by every caller), and that guard needs Redis, so it would turn a Redis
 * outage into 503s from the limiter instead of a report saying Redis is down.
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  async check() {
    const report = await this.health.publicReport();
    if (report.status === 'down') throw new ServiceUnavailableException(report);
    return report;
  }
}

/** The same probes with their error text, plus worker lag: outbox age, webhook backlog, indexer staleness. */
@Public()
@UseGuards(ConsoleAccessGuard)
@PlatformAdminOnly()
@Controller('v1/platform/health')
export class PlatformHealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  report() {
    return this.health.platformReport();
  }
}
