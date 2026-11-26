import { Controller, Get, Header, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import type {
  RequestLogDetail,
  RequestLogErrorGroup,
  RequestLogPage,
  RequestLogSummary,
  RequestLogTail,
  RequestLogTimeseries,
} from '@octap/contracts';
import { RequestLogsService } from '#domain/developer/request-logs.service.js';
import { Public } from '#infra/auth/public.decorator.js';
import { ConsoleAccessGuard, type ConsoleRequest } from './console-access.guard.js';
import type {
  RequestLogFiltersQueryDto,
  RequestLogListQueryDto,
  RequestLogTailQueryDto,
  RequestLogTimeseriesQueryDto,
} from '../dto/console.dto.js';

/**
 * The organization's API call history (OCT-298), for its Owner and Business Developers. Every read
 * takes the same filters; see `RequestLogsService`. Static routes come before `:requestId`.
 */
@Public()
@UseGuards(ConsoleAccessGuard)
@Controller('v1/console/organizations/:organizationId/request-logs')
export class ConsoleRequestLogsController {
  constructor(private readonly logs: RequestLogsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Query() query: RequestLogListQueryDto,
  ): Promise<RequestLogPage> {
    return this.logs.list(req.consoleIdentity.user.id, orgId, query);
  }

  /** RED totals plus the same per category, per endpoint (top 20) and per key. */
  @Get('summary')
  @Header('Cache-Control', 'no-store')
  summary(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Query() query: RequestLogFiltersQueryDto,
  ): Promise<RequestLogSummary> {
    return this.logs.summary(req.consoleIdentity.user.id, orgId, query);
  }

  @Get('timeseries')
  @Header('Cache-Control', 'no-store')
  timeseries(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Query() query: RequestLogTimeseriesQueryDto,
  ): Promise<RequestLogTimeseries> {
    return this.logs.timeseries(req.consoleIdentity.user.id, orgId, query);
  }

  @Get('errors')
  @Header('Cache-Control', 'no-store')
  errors(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Query() query: RequestLogFiltersQueryDto,
  ): Promise<RequestLogErrorGroup[]> {
    return this.logs.errors(req.consoleIdentity.user.id, orgId, query);
  }

  /** Poll with the returned cursor; the first call (no cursor) starts the tail now. */
  @Get('tail')
  @Header('Cache-Control', 'no-store')
  tail(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Query() query: RequestLogTailQueryDto,
  ): Promise<RequestLogTail> {
    return this.logs.tail(req.consoleIdentity.user.id, orgId, query);
  }

  /** One call by its `X-Request-Id`, with a failed call's full error body. */
  @Get(':requestId')
  @Header('Cache-Control', 'no-store')
  detail(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ): Promise<RequestLogDetail> {
    return this.logs.detail(req.consoleIdentity.user.id, orgId, requestId);
  }
}
