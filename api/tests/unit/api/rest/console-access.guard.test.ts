import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import {
  ConsoleAccessGuard,
  MCP_PREPARE_KEY,
  MCP_WITHOUT_ORGANIZATION_KEY,
  MCP_WRITABLE_KEY,
  PLATFORM_ADMIN_ONLY_KEY,
  type ConsoleRequest,
} from '#api/rest/console-access.guard.js';
import type { ConsoleIdentityService } from '#domain/identity/console-identity.service.js';
import type { McpConfirmationService } from '#domain/mcp-auth/mcp-confirmation.service.js';
import type { McpOAuthService } from '#domain/mcp-auth/mcp-oauth.service.js';

const googleIdentity = { user: { id: 'u', systemRole: 'SYSTEM_ADMIN' }, organizations: [] };
const mcpIdentity = { user: { id: 'u', systemRole: 'SYSTEM_ADMIN' }, organizations: [{ organizationId: 'org-a' }] };
const mcpToken = { active: true, organizationId: 'org-a', persona: 'BUSINESS_OWNER', scopes: ['mcp'] };
const writeToken = { ...mcpToken, scopes: ['mcp', 'mcp:write'] };

interface Options {
  platformAdminOnly?: boolean;
  mcpWithoutOrganization?: boolean;
  writable?: boolean;
  prepare?: boolean;
  token?: typeof mcpToken;
}

function setup(platformAdminOnly = false, mcpWithoutOrganization = false, options: Options = {}) {
  const identity = { authenticate: vi.fn(async () => googleIdentity) };
  const token = options.token ?? mcpToken;
  const mcp = { authenticate: vi.fn(async () => ({ identity: mcpIdentity, token })) };
  const confirmations = { consume: vi.fn(async () => ({ kind: 'apply', id: 'confirmation' })) };
  const metadata: Record<string, boolean> = {
    [PLATFORM_ADMIN_ONLY_KEY]: platformAdminOnly,
    [MCP_WITHOUT_ORGANIZATION_KEY]: mcpWithoutOrganization,
    [MCP_WRITABLE_KEY]: options.writable ?? false,
    [MCP_PREPARE_KEY]: options.prepare ?? false,
  };
  const reflector = { getAllAndOverride: vi.fn((key: string) => metadata[key]) };
  const guard = new ConsoleAccessGuard(
    identity as unknown as ConsoleIdentityService,
    mcp as unknown as McpOAuthService,
    confirmations as unknown as McpConfirmationService,
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
  return { run, identity, mcp, confirmations };
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

  it('keeps an MCP token off writes, inside its organization and out of platform routes', async () => {
    const token = bearer('octap_mcp_token');
    // A route that doesn't opt in refuses every MCP write, even with mcp:write.
    await expect(setup().run({ method: 'POST', headers: token }).result).rejects.toThrow('cannot make this change');
    await expect(
      setup(false, false, { token: writeToken }).run({ method: 'PATCH', headers: token }).result,
    ).rejects.toThrow('cannot make this change');
    // A route that opts in still refuses a token without mcp:write.
    await expect(
      setup(false, false, { writable: true }).run({
        method: 'PATCH',
        params: { organizationId: 'org-a' },
        headers: token,
      }).result,
    ).rejects.toThrow('read-only');
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

  it('lets a write token make a confirmed change on a route that opts in (OCT-314)', async () => {
    const headers = bearer('octap_mcp_token');
    const params = { organizationId: 'org-a' };
    const writable = { writable: true, token: writeToken };

    // No confirmation: refused before anything is consumed.
    const unconfirmed = setup(false, false, writable);
    await expect(unconfirmed.run({ method: 'POST', params, headers }).result).rejects.toThrow('confirmed by the user');
    expect(unconfirmed.confirmations.consume).not.toHaveBeenCalled();

    // Another organization: refused before the confirmation is consumed.
    const other = setup(false, false, writable);
    await expect(
      other.run({
        method: 'POST',
        params: { organizationId: 'org-b' },
        headers: { ...headers, 'x-mcp-confirmation': 'c' },
      }).result,
    ).rejects.toThrow('another organization');
    expect(other.confirmations.consume).not.toHaveBeenCalled();

    const confirmed = setup(false, false, writable);
    const { result, request } = confirmed.run({
      method: 'POST',
      path: '/v1/console/organizations/org-a/vouchers',
      body: { code: 'A' },
      params,
      headers: { ...headers, 'x-mcp-confirmation': 'c' },
    });
    await expect(result).resolves.toBe(true);
    expect(confirmed.confirmations.consume).toHaveBeenCalledWith(
      writeToken,
      { method: 'POST', path: '/v1/console/organizations/org-a/vouchers', body: { code: 'A' } },
      'c',
    );
    expect(request.mcpConfirmation).toEqual({ kind: 'apply', id: 'confirmation' });

    // Preparing a change needs mcp:write but no confirmation.
    const prepare = setup(false, false, { prepare: true, token: writeToken });
    await expect(prepare.run({ method: 'POST', params, headers }).result).resolves.toBe(true);
    expect(prepare.confirmations.consume).not.toHaveBeenCalled();
    await expect(
      setup(false, false, { prepare: true }).run({ method: 'POST', params, headers }).result,
    ).rejects.toThrow('read-only');
  });
});
