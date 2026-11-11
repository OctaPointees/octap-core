import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConsoleApiCredentialsService } from '#domain/identity/console-api-credentials.service.js';
import { Public } from '#infra/auth/public.decorator.js';
import { ConsoleAccessGuard, type ConsoleRequest } from './console-access.guard.js';
import type { ConsoleCredentialBodyDto, ConsoleCredentialPatchBodyDto } from '../dto/console.dto.js';

/** Owner or Business Developer of the organization; see `ConsoleApiCredentialsService` for the scope rules. */
@Public()
@UseGuards(ConsoleAccessGuard)
@Controller('v1/console/organizations/:organizationId/api-credentials')
export class ConsoleApiCredentialsController {
  constructor(private readonly credentials: ConsoleApiCredentialsService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() req: ConsoleRequest, @Param('organizationId', ParseUUIDPipe) orgId: string) {
    return this.credentials.list(req.consoleIdentity.user.id, orgId);
  }
  /** The response is the only time the raw key is ever shown. */
  @Post()
  @Header('Cache-Control', 'no-store')
  issue(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Body() body: ConsoleCredentialBodyDto,
  ) {
    return this.credentials.issue(req.consoleIdentity.user.id, orgId, body);
  }
  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  rename(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ConsoleCredentialPatchBodyDto,
  ) {
    return this.credentials.rename(req.consoleIdentity.user.id, orgId, id, body);
  }
  @Delete(':id')
  @Header('Cache-Control', 'no-store')
  revoke(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.credentials.revoke(req.consoleIdentity.user.id, orgId, id);
  }
}
