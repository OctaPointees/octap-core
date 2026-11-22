import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import {
  ConsoleAccessGuard,
  MCP_WITHOUT_ORGANIZATION_KEY,
  PLATFORM_ADMIN_ONLY_KEY,
  type ConsoleRequest,
} from '#api/rest/console-access.guard.js';
import type { ConsoleIdentityService } from '#domain/identity/console-identity.service.js';
import type { McpOAuthService } from '#domain/mcp-auth/mcp-oauth.service.js';

const googleIdentity = { user: { id: 'u', systemRole: 'SYSTEM_ADMIN' }, organizations: [] };
const mcpIdentity = { user: { id: 'u', systemRole: 'SYSTEM_ADMIN' }, organizations: [{ organizationId: 'org-a' }] };
const mcpToken = { active: true, organizationId: 'org-a', persona: 'BUSINESS_OWNER' };

function setup(platformAdminOnly = false, mcpWithoutOrganization = false) {
  const identity = { authenticate: vi.fn(async () => googleIdentity) };
  const mcp = { authenticate: vi.fn(async () => ({ identity: mcpIdentity, token: mcpToken })) };
  const metadata: Record<string, boolean> = {
    [PLATFORM_ADMIN_ONLY_KEY]: platformAdminOnly,
    [MCP_WITHOUT_ORGANIZATION_KEY]: mcpWithoutOrganization,
  };
  const reflector = { getAllAndOverride: vi.fn((key: string) => metadata[key]) };
  const guard = new ConsoleAccessGuard(
    identity as unknown as ConsoleIdentityService,
    mcp as unknown as McpOAuthService,
    reflector as unknown as Reflector,
  );
  const run = (request: Partial<ConsoleRequest>) => {
    const full = { headers: {}, ...request } as ConsoleRequest;
    const context = {
      switchToHttp: () => ({ getRequest: () => full }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;
    return { result: guard.canActivate(context), request: full };
  };
  return { run, identity, mcp };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('ConsoleAccessGuard', () => {
  it('requires a bearer credential', async () => {
    await expect(setup().run({}).result).rejects.toThrow('Google ID token is required');
  });

  it('verifies a Google ID token as before', async () => {
    const { run, identity, mcp } = setup();
    const { result, request } = run({ method: 'POST', headers: bearer('google-id-token') });
    await expect(result).resolves.toBe(true);
    expect(identity.authenticate).toHaveBeenCalledWith('google-id-token');
    expect(mcp.authenticate).not.toHaveBeenCalled();
    expect(request.mcpToken).toBeUndefined();
  });

  it('lets an MCP token read its own organization', async () => {
    const { run, identity } = setup();
    const { result, request } = run({
      method: 'GET',
      params: { organizationId: 'org-a' },
      headers: bearer('octap_mcp_token'),
    });
    await expect(result).resolves.toBe(true);
    expect(identity.authenticate).not.toHaveBeenCalled();
    expect(request.consoleIdentity).toBe(mcpIdentity);
    expect(request.mcpToken).toBe(mcpToken);
  });

  it('keeps an MCP token read-only, inside its organization and out of platform routes', async () => {
    const token = bearer('octap_mcp_token');
    await expect(setup().run({ method: 'POST', headers: token }).result).rejects.toThrow('read-only');
    await expect(setup().run({ method: 'PATCH', headers: token }).result).rejects.toThrow('read-only');
    await expect(
      setup().run({ method: 'GET', params: { organizationId: 'org-b' }, headers: token }).result,
    ).rejects.toThrow('another organization');
    // Even for a System Admin: platform administration needs the Google sign-in.
    await expect(setup(true).run({ method: 'GET', headers: token }).result).rejects.toThrow('platform administration');
  });

  it('keeps an MCP token off routes without an organization unless the route opts in', async () => {
    const token = bearer('octap_mcp_token');
    // e.g. `organization-requests`, which answers across all the user's organizations.
    await expect(setup().run({ method: 'GET', headers: token }).result).rejects.toThrow('its own organization');
    await expect(setup().run({ method: 'GET', params: {}, headers: token }).result).rejects.toThrow(
      'its own organization',
    );
    await expect(setup(false, true).run({ method: 'GET', headers: token }).result).resolves.toBe(true);
    // A Google ID token is unaffected.
    await expect(setup().run({ method: 'GET', headers: bearer('google-id-token') }).result).resolves.toBe(true);
  });
});
