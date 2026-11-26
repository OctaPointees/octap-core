import { setRequestActor } from '#observability/request-context.js';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ConsoleIdentity, McpTokenIntrospection } from '@octap/contracts';
import { ConsoleIdentityService } from '#domain/identity/console-identity.service.js';
import { MCP_TOKEN_PREFIX, McpOAuthService } from '#domain/mcp-auth/mcp-oauth.service.js';

export interface ConsoleRequest {
  method?: string;
  params?: Record<string, string | undefined>;
  headers: { authorization?: string };
  consoleIdentity: ConsoleIdentity;
  /** Set when the caller used an MCP access token rather than a Google ID token. */
  mcpToken?: McpTokenIntrospection;
}
export const PLATFORM_ADMIN_ONLY_KEY = 'console.platform-admin';
export const PlatformAdminOnly = () => SetMetadata(PLATFORM_ADMIN_ONLY_KEY, true);
export const MCP_WITHOUT_ORGANIZATION_KEY = 'console.mcp-without-organization';
/**
 * Lets an MCP access token reach a route that has no `:organizationId`. Only for routes that answer
 * from the token itself, never from the user's other organizations.
 */
export const McpWithoutOrganization = () => SetMetadata(MCP_WITHOUT_ORGANIZATION_KEY, true);

@Injectable()
export class ConsoleAccessGuard implements CanActivate {
  constructor(
    private readonly identity: ConsoleIdentityService,
    private readonly mcp: McpOAuthService,
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
      // An MCP token reads one organization as one persona, and never writes: the membership and
      // persona checks behind each route still run, this only narrows what the token can reach.
      if (request.method !== 'GET' && request.method !== 'HEAD')
        throw new ForbiddenException('MCP access is read-only');
      if (platformAdminOnly) throw new ForbiddenException('MCP access cannot reach platform administration');
      // Deny by default: a route without `:organizationId` can answer across all the user's
      // organizations (e.g. `organization-requests`), which a token bound to one must not read.
      const organizationId = request.params?.organizationId;
      if (organizationId === undefined) {
        const allowed = this.reflector.getAllAndOverride<boolean>(MCP_WITHOUT_ORGANIZATION_KEY, [
          context.getHandler(),
          context.getClass(),
        ]);
        if (!allowed) throw new ForbiddenException('MCP access only reaches routes of its own organization');
      } else if (organizationId !== token.organizationId)
        throw new ForbiddenException('This MCP access token is for another organization');
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
