import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { SetVoucherRefundPolicyRequest, VoucherRefundPolicyDto } from '@octap/contracts';
import { ConsoleRefundPolicyService } from '#domain/rewards/console-refund-policy.service.js';
import { Public } from '#infra/auth/public.decorator.js';
import { ConsoleAccessGuard, McpWritable, type ConsoleRequest } from './console-access.guard.js';

/** Owner only, reads included. See `ConsoleRefundPolicyService`. */
@Public()
@UseGuards(ConsoleAccessGuard)
@Controller('v1/console/organizations/:organizationId/refund-policy')
export class ConsoleRefundPolicyController {
  constructor(private readonly policies: ConsoleRefundPolicyService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  current(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
  ): Promise<VoucherRefundPolicyDto> {
    return this.policies.current(req.consoleIdentity.user.id, orgId);
  }

  @Get('history')
  @Header('Cache-Control', 'no-store')
  history(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('beforeVersion', new ParseIntPipe({ optional: true })) beforeVersion?: number,
  ): Promise<VoucherRefundPolicyDto[]> {
    return this.policies.history(req.consoleIdentity.user.id, orgId, { limit, beforeVersion });
  }

  /** Publishes the next version, recorded against the signed-in Owner. */
  @Put()
  @McpWritable()
  @Header('Cache-Control', 'no-store')
  publish(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Body() body: SetVoucherRefundPolicyRequest,
  ): Promise<VoucherRefundPolicyDto> {
    return this.policies.publish(req.consoleIdentity.user.id, orgId, body);
  }
}
