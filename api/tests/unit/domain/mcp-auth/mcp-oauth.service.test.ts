import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { ConsoleIdentity } from '@octap/contracts';
import {
  MCP_TOKEN_PREFIX,
  McpOAuthService,
  OAuthProtocolError,
  isAllowedRedirectUri,
} from '#domain/mcp-auth/mcp-oauth.service.js';
import type { GoogleIdentityClient } from '#infra/clients/google/google-identity.client.js';
import type { ConsoleUsersRepository } from '#infra/db/repositories/console-users.repository.js';

type Organization = ConsoleIdentity['organizations'][number];

/** The four Redis commands the service uses, over a Map. TTLs are not modelled. */
function fakeRedis() {
  const store = new Map<string, string>();
  const redis = {
    set: vi.fn(async (key: string, value: string) => (store.set(key, value), 'OK')),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    getdel: vi.fn(async (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    }),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  };
  return { redis, store };
}

const org = (organizationId: string, persona: Organization['persona'] = 'BUSINESS_OWNER'): Organization => ({
  organizationId,
  name: `Org ${organizationId}`,
  slug: organizationId,
  persona,
  organizationType: null,
  representativeName: null,
});

const REDIRECT = 'http://localhost:6274/oauth/callback';
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

function setup(organizations: Organization[] = [org('org-a')]) {
  const { redis, store } = fakeRedis();
  let memberships = organizations;
  // The Google token in these tests is the nonce it was minted with.
  const google = {
    verify: vi.fn(async (token: string) => ({
      subject: 'google-sub',
      email: 'owner@example.com',
      fullName: 'Owner',
      avatarUrl: null,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      nonce: token,
    })),
  };
  const user = {
    id: 'user-1',
    email: 'owner@example.com',
    fullName: 'Owner',
    avatarUrl: null,
    systemRole: 'SYSTEM_USER',
  };
  const users = {
    resolveGoogleUser: vi.fn(async () => user),
    findById: vi.fn(async (id: string) => (id === user.id ? user : null)),
    memberships: vi.fn(async () => memberships),
  };
  const service = new McpOAuthService(
    redis as unknown as Redis,
    google as unknown as GoogleIdentityClient,
    users as unknown as ConsoleUsersRepository,
  );
  const clientId = service.register({ client_name: 'Inspector', redirect_uris: [REDIRECT] }).client_id;
  const authorize = (overrides: Record<string, unknown> = {}) =>
    service.startAuthorization({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      state: 'xyz',
      resource: 'http://localhost:4100/mcp',
      ...overrides,
    });
  const codeFrom = (redirectTo: string) => new URL(redirectTo).searchParams.get('code')!;
  const exchange = (code: string, overrides: Record<string, unknown> = {}) =>
    service.exchangeCode({
      grant_type: 'authorization_code',
      code,
      code_verifier: VERIFIER,
      client_id: clientId,
      redirect_uri: REDIRECT,
      ...overrides,
    });
  /** Runs the whole flow for a one-organization user and returns the access token. */
  const signIn = async () => {
    const { requestId } = await authorize();
    const step = await service.completeGoogleSignIn(requestId, requestId);
    if (!('redirectTo' in step)) throw new Error('expected a redirect');
    return (await exchange(codeFrom(step.redirectTo))).access_token;
  };
  return {
    service,
    store,
    users,
    clientId,
    authorize,
    exchange,
    codeFrom,
    signIn,
    setMemberships: (next: Organization[]) => (memberships = next),
  };
}

beforeEach(() => {
  vi.stubEnv('MCP_OAUTH_ISSUER_URL', 'https://api.octap.example/');
  vi.stubEnv('MCP_OAUTH_SIGNING_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubEnv('CONSOLE_GOOGLE_CLIENT_ID', 'google-client');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('McpOAuthService metadata and registration', () => {
  it('publishes RFC 8414 metadata under the configured issuer, PKCE S256 only', () => {
    const { service } = setup();
    expect(service.metadata()).toMatchObject({
      issuer: 'https://api.octap.example',
      authorization_endpoint: 'https://api.octap.example/oauth/authorize',
      token_endpoint: 'https://api.octap.example/oauth/token',
      registration_endpoint: 'https://api.octap.example/oauth/register',
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });

  it('answers 503 until both MCP settings are configured', () => {
    vi.stubEnv('MCP_OAUTH_SIGNING_KEY', '');
    const { redis } = fakeRedis();
    const service = new McpOAuthService(redis as unknown as Redis, {} as never, {} as never);
    expect(() => service.register({ redirect_uris: [REDIRECT] })).toThrow('MCP sign-in is not configured');
  });

  it('registers public clients only, with safe redirect URIs', () => {
    const { service } = setup();
    for (const body of [
      {},
      { redirect_uris: [] },
      { redirect_uris: ['http://evil.example/cb'] },
      { redirect_uris: ['javascript:alert(1)'] },
      { redirect_uris: ['https://host/cb#frag'] },
      { redirect_uris: Array.from({ length: 6 }, (_, i) => `https://host/${i}`) },
    ])
      expect(() => service.register(body)).toThrow(OAuthProtocolError);
    expect(() =>
      service.register({ redirect_uris: ['https://claude.ai/cb'], token_endpoint_auth_method: 'client_secret_basic' }),
    ).toThrow('Only public clients');
    expect(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(isAllowedRedirectUri('http://127.0.0.1:33418/callback')).toBe(true);
    expect(isAllowedRedirectUri('cursor://anysphere.cursor-retrieval/oauth/callback')).toBe(true);
  });

  it('refuses a client id that was tampered with or signed by another key', async () => {
    const { clientId, authorize } = setup();
    const [payload, signature] = clientId.slice('mcpc_'.length).split('.');
    const forged = Buffer.from(JSON.stringify({ n: 'x', r: ['https://evil.example/cb'] })).toString('base64url');
    await expect(
      authorize({ client_id: `mcpc_${forged}.${signature}`, redirect_uri: 'https://evil.example/cb' }),
    ).rejects.toThrow('Unknown client_id');
    vi.stubEnv('MCP_OAUTH_SIGNING_KEY', Buffer.alloc(32, 8).toString('base64'));
    await expect(authorize({ client_id: `mcpc_${payload}.${signature}` })).rejects.toThrow('Unknown client_id');
  });
});

describe('McpOAuthService authorization', () => {
  it('requires a registered redirect URI, code response type, PKCE S256 and the mcp scope', async () => {
    const { authorize } = setup();
    await expect(authorize({ redirect_uri: 'http://localhost:9/other' })).rejects.toThrow('Unknown client_id');
    await expect(authorize({ response_type: 'token' })).rejects.toThrow('response_type must be code');
    await expect(authorize({ code_challenge_method: 'plain' })).rejects.toThrow('PKCE is required');
    await expect(authorize({ code_challenge: undefined })).rejects.toThrow('PKCE is required');
    await expect(authorize({ scope: 'admin' })).rejects.toThrow('Only the mcp and mcp:write scopes');
    await expect(authorize({ resource: 'not a url' })).rejects.toThrow('resource is required');
    await expect(authorize({ resource: undefined })).rejects.toThrow('resource is required');
    const view = await authorize({ scope: 'mcp' });
    expect(view).toMatchObject({
      clientName: 'Inspector',
      redirectHost: 'localhost:6274',
      googleClientId: 'google-client',
    });
  });

  it('refuses a Google token minted for another request or for the console', async () => {
    const { service, authorize } = setup();
    const { requestId } = await authorize();
    await expect(service.completeGoogleSignIn(requestId, 'other-nonce')).rejects.toThrow('not made for this request');
    await expect(service.completeGoogleSignIn('unknown', 'unknown')).rejects.toThrow('This sign-in expired');
  });

  it('refuses a user with no Owner or Developer organization', async () => {
    const { service, authorize } = setup([]);
    const { requestId } = await authorize();
    await expect(service.completeGoogleSignIn(requestId, requestId)).rejects.toThrow('not an Owner or Developer');
  });

  it('issues a code for the only organization, redirecting with state and issuer', async () => {
    const { service, authorize } = setup();
    const { requestId } = await authorize();
    const step = await service.completeGoogleSignIn(requestId, requestId);
    expect('redirectTo' in step).toBe(true);
    const redirect = new URL((step as { redirectTo: string }).redirectTo);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT);
    expect(redirect.searchParams.get('state')).toBe('xyz');
    expect(redirect.searchParams.get('iss')).toBe('https://api.octap.example');
    // The pending request issues one code only.
    await expect(service.completeGoogleSignIn(requestId, requestId)).rejects.toThrow('This sign-in expired');
  });

  it('lets a user in several organizations pick one of their own', async () => {
    const { service, authorize, exchange, codeFrom } = setup([org('org-a'), org('org-b', 'BUSINESS_DEVELOPER')]);
    const { requestId } = await authorize();
    const step = await service.completeGoogleSignIn(requestId, requestId);
    expect(step).toEqual({
      organizations: [
        { organizationId: 'org-a', name: 'Org org-a', persona: 'BUSINESS_OWNER' },
        { organizationId: 'org-b', name: 'Org org-b', persona: 'BUSINESS_DEVELOPER' },
      ],
    });
    await expect(service.chooseOrganization(requestId, 'org-z')).rejects.toThrow('not an Owner or Developer');
    const chosen = await service.chooseOrganization(requestId, 'org-b');
    const token = (await exchange(codeFrom((chosen as { redirectTo: string }).redirectTo))).access_token;
    expect((await service.authenticate(token)).token).toMatchObject({
      organizationId: 'org-b',
      persona: 'BUSINESS_DEVELOPER',
    });
  });
});

describe('McpOAuthService token exchange', () => {
  it('exchanges a code once, and only with the matching client, redirect URI, verifier and resource', async () => {
    const { service, authorize, exchange, codeFrom, clientId } = setup();
    const issue = async () => {
      const { requestId } = await authorize();
      return codeFrom(
        ((await service.completeGoogleSignIn(requestId, requestId)) as { redirectTo: string }).redirectTo,
      );
    };
    for (const overrides of [
      { code_verifier: 'w'.repeat(64) },
      { redirect_uri: 'http://localhost:6274/other' },
      { client_id: `${clientId}x` },
      { resource: 'http://localhost:9999/mcp' },
    ])
      await expect(exchange(await issue(), overrides)).rejects.toMatchObject({
        response: { error: 'invalid_grant' },
      });
    await expect(exchange('code', { grant_type: 'refresh_token' })).rejects.toMatchObject({
      response: { error: 'unsupported_grant_type' },
    });
    const code = await issue();
    const tokens = await exchange(code, { resource: 'http://localhost:4100/mcp' });
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp' });
    expect(tokens.access_token.startsWith(MCP_TOKEN_PREFIX)).toBe(true);
    await expect(exchange(code)).rejects.toMatchObject({ response: { error: 'invalid_grant' } });
  });

  it('stores only hashes of codes and tokens', async () => {
    const { signIn, store } = setup();
    const token = await signIn();
    expect([...store.keys()].some((key) => key.includes(token))).toBe(false);
    expect([...store.values()].some((value) => value.includes(token))).toBe(false);
  });
});

describe('McpOAuthService access tokens', () => {
  it('resolves a token to the bound organization only', async () => {
    const { service, signIn } = setup([org('org-a')]);
    const token = await signIn();
    const { identity, token: introspection } = await service.authenticate(token);
    expect(identity.user).toMatchObject({ id: 'user-1', email: 'owner@example.com' });
    expect(identity.organizations.map((o) => o.organizationId)).toEqual(['org-a']);
    expect(introspection).toMatchObject({
      active: true,
      userId: 'user-1',
      organizationId: 'org-a',
      persona: 'BUSINESS_OWNER',
      resource: 'http://localhost:4100/mcp',
      scopes: ['mcp'],
    });
  });

  it('refuses unknown, revoked and expired tokens', async () => {
    const { service, signIn } = setup();
    await expect(service.authenticate(`${MCP_TOKEN_PREFIX}unknown`)).rejects.toThrow('invalid or expired');
    const revoked = await signIn();
    await service.revoke({ token: revoked });
    await expect(service.authenticate(revoked)).rejects.toThrow('invalid or expired');
    const expired = await signIn();
    vi.useFakeTimers({ now: Date.now() + 3601 * 1000 });
    try {
      await expect(service.authenticate(expired)).rejects.toThrow('invalid or expired');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a token once its user loses the membership or the persona changes', async () => {
    const { service, signIn, setMemberships } = setup([org('org-a')]);
    const lost = await signIn();
    setMemberships([]);
    await expect(service.authenticate(lost)).rejects.toThrow('access to this organization changed');
    setMemberships([org('org-a')]);
    // Removed on first refusal, so restoring the membership does not revive it.
    await expect(service.authenticate(lost)).rejects.toThrow('invalid or expired');
    const demoted = await signIn();
    setMemberships([org('org-a', 'BUSINESS_DEVELOPER')]);
    await expect(service.authenticate(demoted)).rejects.toThrow('access to this organization changed');
  });
});
