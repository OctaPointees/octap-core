import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { Public } from '#infra/auth/public.decorator.js';
import { ConsoleIdentityService } from '#domain/identity/console-identity.service.js';
import { MCP_TOKEN_PREFIX, McpOAuthService } from '#domain/mcp-auth/mcp-oauth.service.js';
import type { ConsoleGoogleLoginBodyDto } from '../dto/console.dto.js';

/** These routes verify Google credentials directly, never merchant API keys. */
@Public()
@Controller('v1/console')
export class ConsoleIdentityController {
  constructor(
    private readonly identity: ConsoleIdentityService,
    private readonly mcp: McpOAuthService,
  ) {}

  @Post('auth/google')
  @Header('Cache-Control', 'no-store')
  login(@Body() body: ConsoleGoogleLoginBodyDto) {
    if (typeof body?.idToken !== 'string') throw new BadRequestException('idToken is required');
    return this.identity.authenticate(body.idToken);
  }

  /** With an MCP access token, the identity lists only the organization the token is bound to. */
  @Get('me')
  @Header('Cache-Control', 'no-store')
  async me(@Headers('authorization') authorization?: string) {
    if (!authorization?.startsWith('Bearer ')) throw new UnauthorizedException('Google ID token is required');
    const credential = authorization.slice(7);
    if (credential.startsWith(MCP_TOKEN_PREFIX)) return (await this.mcp.authenticate(credential)).identity;
    return this.identity.authenticate(credential);
  }
}
