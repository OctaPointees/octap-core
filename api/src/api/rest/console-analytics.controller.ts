import { Controller, Get, Header, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import type { ProgramAnalyticsSummary } from '@octap/contracts';
import { ProgramAnalyticsService } from '#domain/analytics/program-analytics.service.js';
import { Public } from '#infra/auth/public.decorator.js';
import { ConsoleAccessGuard, type ConsoleRequest } from './console-access.guard.js';
import type { ProgramAnalyticsQueryDto } from '../dto/console.dto.js';

/**
 * How the organization's points and vouchers actually moved, for its Owner and Business
 * Developers. Defaults to the last 30 days when `from`/`to` are omitted. See
 * `ProgramAnalyticsSummary` for what each figure means and why it is shown.
 */
@Public()
@UseGuards(ConsoleAccessGuard)
@Controller('v1/console/organizations/:organizationId/analytics')
export class ConsoleAnalyticsController {
  constructor(private readonly analytics: ProgramAnalyticsService) {}

  @Get('summary')
  @Header('Cache-Control', 'no-store')
  summary(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Query() query: ProgramAnalyticsQueryDto,
  ): Promise<ProgramAnalyticsSummary> {
    return this.analytics.summaryAsMember(req.consoleIdentity.user.id, orgId, { ...query });
  }
}
