import type { OrganizationPersona } from './system-users.js';

/**
 * `GET /v1/console/mcp/token`: what an MCP access token is bound to, for the MCP server (an OAuth
 * resource server) to check on every request. Answered only for a live token; any other is a 401.
 */
export interface McpTokenIntrospection {
  active: true;
  /** The MCP host's OAuth client id from dynamic registration. */
  clientId: string;
  /** `mcp` (read), plus `mcp:write` when the user allowed changes at sign-in (OCT-314). */
  scopes: string[];
  userId: string;
  /** The one organization this token can reach. */
  organizationId: string;
  /** The user's persona in that organization when the token was issued; Core rechecks it per request. */
  persona: OrganizationPersona;
  /** The RFC 8707 resource (the MCP server URL) the token was issued for. */
  resource: string;
  /** Expiry in seconds since the epoch. */
  expiresAt: number;
}

/**
 * `POST /v1/console/organizations/:organizationId/mcp/confirmations` (OCT-314), with an MCP token that
 * has `mcp:write`: a change to show the user before making it. Nothing changes yet.
 */
export interface McpConfirmationInput {
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** A console route of the token's organization, e.g. `/v1/console/organizations/<id>/vouchers`. */
  path: string;
  /** The JSON body to send; `{}` when the route takes none. */
  body?: Record<string, unknown>;
  /** What the change does, in words the user confirms (1-1000 characters). */
  summary: string;
}

/**
 * A prepared change. The host shows `summary`, and only once the user agrees sends `method path` with
 * exactly `body` and the header `X-Mcp-Confirmation: <confirmationId>`. The id works once, for that
 * request only, until `expiresAt` (5 minutes). A retry of the same request with the same id returns
 * the first answer instead of making the change again.
 */
export interface McpConfirmation {
  confirmationId: string;
  method: McpConfirmationInput['method'];
  path: string;
  body: Record<string, unknown>;
  summary: string;
  expiresAt: string;
}
