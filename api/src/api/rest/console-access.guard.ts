import { setRequestActor } from '#observability/request-context.js';
import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  ForbiddenException,
  UseInterceptors,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ConsoleIdentity, McpTokenIntrospection } from '@octap/contracts';
import { ConsoleIdentityService } from '#domain/identity/console-identity.service.js';
import {
  MCP_CONFIRMATION_HEADER,
  McpConfirmationService,
  type McpConfirmationOutcome,
} from '#domain/mcp-auth/mcp-confirmation.service.js';
import { MCP_TOKEN_PREFIX, MCP_WRITE_SCOPE, McpOAuthService } from '#domain/mcp-auth/mcp-oauth.service.js';
import { McpConfirmationInterceptor } from './mcp-confirmation.interceptor.js';

export interface ConsoleRequest {
  method?: string;
  /** The path without the query string (Express). */
  path?: string;
  body?: unknown;
  params?: Record<string, string | undefined>;
  headers: { authorization?: string; [MCP_CONFIRMATION_HEADER]?: string };
  consoleIdentity: ConsoleIdentity;
  /** Set when the caller used an MCP access token rather than a Google ID token. */
  mcpToken?: McpTokenIntrospection;
  /** Set on a confirmed MCP write (OCT-314), for `McpConfirmationInterceptor`. */
  mcpConfirmation?: McpConfirmationOutcome;
}
export const PLATFORM_ADMIN_ONLY_KEY = 'console.platform-admin';
export const PlatformAdminOnly = () => SetMetadata(PLATFORM_ADMIN_ONLY_KEY, true);
export const MCP_WITHOUT_ORGANIZATION_KEY = 'console.mcp-without-organization';
/**
 * Lets an MCP access token reach a route that has no `:organizationId`. Only for routes that answer
 * from the token itself, never from the user's other organizations.
 */
export const McpWithoutOrganization = () => SetMetadata(MCP_WITHOUT_ORGANIZATION_KEY, true);
export const MCP_WRITABLE_KEY = 'console.mcp-writable';
/**
 * Lets an MCP token with `mcp:write` make this change (OCT-314), once the user confirmed it: the
 * request must carry a confirmation id for exactly this request. Every other write refuses MCP tokens.
 * The route's own membership and persona checks still run.
 */
export const McpWritable = () =>
  applyDecorators(SetMetadata(MCP_WRITABLE_KEY, true), UseInterceptors(McpConfirmationInterceptor));
export const MCP_PREPARE_KEY = 'console.mcp-prepare';
/** The route that stores a change to confirm: a write token reaches it without a confirmation. */
export const McpPrepare = () => SetMetadata(MCP_PREPARE_KEY, true);

@Injectable()
export class ConsoleAccessGuard implements CanActivate {
  constructor(
    private readonly identity: ConsoleIdentityService,
    private readonly mcp: McpOAuthService,
    private readonly confirmations: McpConfirmationService,
    private readonly reflector: Reflector,
  ) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<ConsoleRequest>();
    const credential = /^Bearer (.+)$/i.exec(request.headers.authorization ?? '')?.[1];
    if (!credential) throw new UnauthorizedException('Google ID token is required');
    const platformAdminOnly = this.reflector.getAllAndOverride<boolean>(PLATFORM_ADMIN_ONLY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (credential.startsWith(MCP_TOKEN_PREFIX)) {
      const { identity, token } = await this.mcp.authenticate(credential);
      // An MCP token reaches one organization as one persona, and writes only where a route opts in,
      // with `mcp:write` and the user's confirmation (OCT-314). The membership and persona checks
      // behind each route still run; this only narrows what the token can reach.
      const writing = request.method !== 'GET' && request.method !== 'HEAD';
      const flag = (key: string) =>
        this.reflector.getAllAndOverride<boolean>(key, [context.getHandler(), context.getClass()]) === true;
      const writable = writing && flag(MCP_WRITABLE_KEY);
      if (writing) {
        if (!writable && !flag(MCP_PREPARE_KEY)) throw new ForbiddenException('MCP access cannot make this change');
        if (!token.scopes.includes(MCP_WRITE_SCOPE))
          throw new ForbiddenException(
            'This MCP connection is read-only. Sign in again from your MCP client and allow it to make changes.',
          );
      }
      if (platformAdminOnly) throw new ForbiddenException('MCP access cannot reach platform administration');
      // Deny by default: a route without `:organizationId` can answer across all the user's
      // organizations (e.g. `organization-requests`), which a token bound to one must not read.
      const organizationId = request.params?.organizationId;
      if (organizationId === undefined) {
        if (!flag(MCP_WITHOUT_ORGANIZATION_KEY))
          throw new ForbiddenException('MCP access only reaches routes of its own organization');
      } else if (organizationId !== token.organizationId)
        throw new ForbiddenException('This MCP access token is for another organization');
      if (writable) {
        const confirmationId = request.headers[MCP_CONFIRMATION_HEADER];
        if (!confirmationId)
          throw new ForbiddenException(
            'An MCP change must be confirmed by the user first: prepare it, then confirm it.',
          );
        request.mcpConfirmation = await this.confirmations.consume(
          token,
          { method: request.method ?? '', path: request.path ?? '', body: request.body },
          confirmationId,
        );
      }
      request.consoleIdentity = identity;
      request.mcpToken = token;
      setRequestActor({ type: 'USER', id: identity.user.id });
      return true;
    }
    request.consoleIdentity = await this.identity.authenticate(credential);
    setRequestActor({ type: 'USER', id: request.consoleIdentity.user.id });
    if (platformAdminOnly && request.consoleIdentity.user.systemRole !== 'SYSTEM_ADMIN')
      throw new ForbiddenException('System Admin access is required');
    return true;
  }
}
