import type { OrganizationPersona } from './system-users.js';

/**
 * `GET /v1/console/mcp/token`: what an MCP access token is bound to, for the MCP server (an OAuth
 * resource server) to check on every request. Answered only for a live token; any other is a 401.
 */
export interface McpTokenIntrospection {
  active: true;
  /** The MCP host's OAuth client id from dynamic registration. */
  clientId: string;
  scopes: string[];
  userId: string;
  /** The one organization this token can read. */
  organizationId: string;
  /** The user's persona in that organization when the token was issued; Core rechecks it per request. */
  persona: OrganizationPersona;
  /** The RFC 8707 resource (the MCP server URL) the token was issued for. */
  resource: string;
  /** Expiry in seconds since the epoch. */
  expiresAt: number;
}
