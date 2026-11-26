import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ConsoleWebhooksService } from '#domain/webhooks/console-webhooks.service.js';
import { Public } from '#infra/auth/public.decorator.js';
import { ConsoleAccessGuard, type ConsoleRequest } from './console-access.guard.js';
import type { RegisterWebhookEndpointBodyDto } from '../dto/webhooks.dto.js';
import { RequiresFeature } from '#infra/auth/requires-feature.decorator.js';
import { LicenseFeatureGuard } from './license-feature.guard.js';

/** Owner only, reads included. See `ConsoleWebhooksService`. */
@Public()
@UseGuards(ConsoleAccessGuard)
@Controller('v1/console/organizations/:organizationId/webhooks')
export class ConsoleWebhooksController {
  constructor(private readonly webhooks: ConsoleWebhooksService) {}

  @Get('endpoints')
  @Header('Cache-Control', 'no-store')
  listEndpoints(@Req() req: ConsoleRequest, @Param('organizationId', ParseUUIDPipe) orgId: string) {
    return this.webhooks.listEndpoints(req.consoleIdentity.user.id, orgId);
  }

  /** Returns the signing secret, this once. */
  @Post('endpoints')
  @RequiresFeature('webhooks')
  @UseGuards(LicenseFeatureGuard)
  @Header('Cache-Control', 'no-store')
  registerEndpoint(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Body() body: RegisterWebhookEndpointBodyDto,
  ) {
    return this.webhooks.registerEndpoint(req.consoleIdentity.user.id, orgId, body);
  }

  @Post('endpoints/:id/disable')
  @Header('Cache-Control', 'no-store')
  disableEndpoint(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.webhooks.disableEndpoint(req.consoleIdentity.user.id, orgId, id);
  }

  @Post('endpoints/:id/enable')
  @RequiresFeature('webhooks')
  @UseGuards(LicenseFeatureGuard)
  @Header('Cache-Control', 'no-store')
  enableEndpoint(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.webhooks.enableEndpoint(req.consoleIdentity.user.id, orgId, id);
  }

  /** Returns the new signing secret, this once. */
  @Post('endpoints/:id/rotate-secret')
  @Header('Cache-Control', 'no-store')
  rotateSecret(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.webhooks.rotateSecret(req.consoleIdentity.user.id, orgId, id);
  }

  /** Sends a `webhook.test` event to this endpoint only, through the normal signed delivery. */
  @Post('endpoints/:id/test')
  @Header('Cache-Control', 'no-store')
  sendTestEvent(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.webhooks.sendTestEvent(req.consoleIdentity.user.id, orgId, id);
  }

  @Get('deliveries')
  @Header('Cache-Control', 'no-store')
  listDeliveries(@Req() req: ConsoleRequest, @Param('organizationId', ParseUUIDPipe) orgId: string) {
    return this.webhooks.listDeliveries(req.consoleIdentity.user.id, orgId);
  }

  /** Re-queues a DEAD_LETTER delivery, same event id. */
  @Post('deliveries/:id/replay')
  @Header('Cache-Control', 'no-store')
  replayDelivery(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.webhooks.replayDelivery(req.consoleIdentity.user.id, orgId, id);
  }
}
