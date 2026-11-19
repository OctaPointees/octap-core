import { Body, Controller, Get, Header, HttpCode, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { McpTokenIntrospection } from '@octap/contracts';
import { Public } from '#infra/auth/public.decorator.js';
import { PublicRateLimitGuard } from '#infra/auth/public-rate-limit.guard.js';
import {
  McpOAuthService,
  OAuthProtocolError,
  type AuthorizationParams,
  type AuthorizationStep,
} from '#domain/mcp-auth/mcp-oauth.service.js';
import { ConsoleAccessGuard, type ConsoleRequest } from './console-access.guard.js';
import { renderAuthorizationError, renderAuthorizationPage } from './mcp-oauth.page.js';

/** The part of Express's response the sign-in page sets its status through. */
interface StatusResponse {
  status(code: number): unknown;
}

/**
 * OAuth 2.1 authorization server for MCP hosts (OCT-293). Public by design: these routes are how a
 * host gets a credential in the first place. All but metadata are rate limited per client IP.
 */
@Public()
@Controller()
export class McpOAuthController {
  constructor(private readonly oauth: McpOAuthService) {}

  @Get('.well-known/oauth-authorization-server')
  metadata() {
    return this.oauth.metadata();
  }

  @Post('oauth/register')
  @UseGuards(PublicRateLimitGuard)
  @Header('Cache-Control', 'no-store')
  register(@Body() body: Record<string, unknown>) {
    return this.oauth.register(body);
  }

  /** The sign-in page (HTML). An invalid request gets an error page, never a redirect to an unverified URI. */
  @Get('oauth/authorize')
  @UseGuards(PublicRateLimitGuard)
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('X-Frame-Options', 'DENY')
  @Header('Content-Security-Policy', "frame-ancestors 'none'")
  @Header('Referrer-Policy', 'no-referrer')
  async authorize(
    @Query() query: AuthorizationParams,
    @Res({ passthrough: true }) response: StatusResponse,
  ): Promise<string> {
    try {
      return renderAuthorizationPage(await this.oauth.startAuthorization(query));
    } catch (error) {
      if (!(error instanceof OAuthProtocolError)) throw error;
      response.status(400);
      return renderAuthorizationError((error.getResponse() as { error_description: string }).error_description);
    }
  }

  @Post('oauth/authorize/google')
  @UseGuards(PublicRateLimitGuard)
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  google(@Body() body: { requestId?: string; credential?: string }): Promise<AuthorizationStep> {
    return this.oauth.completeGoogleSignIn(body?.requestId, body?.credential);
  }

  @Post('oauth/authorize/organization')
  @UseGuards(PublicRateLimitGuard)
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  organization(@Body() body: { requestId?: string; organizationId?: string }): Promise<AuthorizationStep> {
    return this.oauth.chooseOrganization(body?.requestId, body?.organizationId);
  }

  @Post('oauth/token')
  @UseGuards(PublicRateLimitGuard)
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  token(@Body() body: Record<string, unknown>) {
    return this.oauth.exchangeCode(body);
  }

  @Post('oauth/revoke')
  @UseGuards(PublicRateLimitGuard)
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  revoke(@Body() body: Record<string, unknown>) {
    return this.oauth.revoke(body);
  }
}

/** What an MCP access token is bound to, for the MCP server to check on every request. */
@Public()
@UseGuards(ConsoleAccessGuard)
@Controller('v1/console/mcp')
export class ConsoleMcpTokenController {
  @Get('token')
  @Header('Cache-Control', 'no-store')
  token(@Req() request: ConsoleRequest): McpTokenIntrospection {
    if (!request.mcpToken) throw new OAuthProtocolError('invalid_token', 'An MCP access token is required', 401);
    return request.mcpToken;
  }
}
