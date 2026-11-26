import { Controller, Get, Header, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import type { AuditLogPage } from '@octap/contracts';
import { AuditLogService } from '#domain/audit/audit-log.service.js';
import { Public } from '#infra/auth/public.decorator.js';
import { ConsoleAccessGuard, type ConsoleRequest } from './console-access.guard.js';
import type { AuditLogQueryDto } from '../dto/console.dto.js';

/** The organization's audit log (OCT-333), newest first. Owner only. */
@Public()
@UseGuards(ConsoleAccessGuard)
@Controller('v1/console/organizations/:organizationId/audit-log')
export class ConsoleAuditLogController {
  constructor(private readonly auditLog: AuditLogService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Query() query: AuditLogQueryDto,
  ): Promise<AuditLogPage> {
    return this.auditLog.list(req.consoleIdentity.user.id, orgId, query);
  }
}
