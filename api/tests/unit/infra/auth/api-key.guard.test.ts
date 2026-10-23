import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { Redis } from 'ioredis';
import { ApiKeyGuard } from '../../../../src/infra/auth/api-key.guard.js';
import { hashApiKey } from '../../../../src/infra/auth/api-key-hash.util.js';
import { Scopes, SCOPES_KEY } from '../../../../src/infra/auth/scopes.decorator.js';
import { RequireSignedRequest, REQUIRE_SIGNED_REQUEST_KEY } from '../../../../src/infra/auth/signed-request.decorator.js';
import { IS_PUBLIC_KEY, Public } from '../../../../src/infra/auth/public.decorator.js';
import { IdentityController } from '../../../../src/api/rest/identity.controller.js';
import { CreditsController } from '../../../../src/api/rest/credits.controller.js';
import { buildCanonicalRequest, signCanonicalRequest } from '../../../../src/infra/auth/request-signing.util.js';
import { RATE_LIMIT_MAX_REQUESTS } from '../../../../src/infra/auth/rate-limit.util.js';
import type { ApiCredentialsRepository } from '../../../../src/infra/db/repositories/api-credentials.repository.js';
import { stub } from '../../../helpers/stub.js';
import { fakeRedis } from '../../../helpers/redis.js';
import { executionContext } from '../../../helpers/fixtures.js';

const activeCredential = (overrides: Record<string, unknown> = {}) => ({
  id: 'cred-1',
  organizationId: 'org-1',
  status: 'ACTIVE',
  expiresAt: null,
  scopes: ['read', 'write'],
  ...overrides,
});

function guard(credential: unknown, redis: Redis = fakeRedis(), touchLastUsed = vi.fn(async () => {})) {
  const repo = stub<ApiCredentialsRepository>({ findByKeyHash: async () => credential, touchLastUsed });
  return new ApiKeyGuard(repo, new Reflector(), redis);
}

/** Equivalent to writing the decorator on a controller method (no TS decorator syntax needed). */
function route(...decorators: MethodDecorator[]) {
  function handler() {}
  for (const decorate of decorators) {
    decorate(handler, 'handler', { value: handler });
  }
  return handler;
}

const SIGNED_PATH = '/v1/api-credentials';

function signedContext({
  rawKey = 'octap_live_signed',
  signingKey = hashApiKey(rawKey),
  body = '{}',
  nonce = 'nonce-1',
  timestamp = Math.floor(Date.now() / 1000),
  signature,
  originalUrl,
}: {
  rawKey?: string;
  signingKey?: string;
  body?: string;
  nonce?: string;
  timestamp?: number | string;
  signature?: string;
  originalUrl?: string;
} = {}) {
  const canonical = buildCanonicalRequest({ method: 'POST', path: SIGNED_PATH, timestamp: String(timestamp), nonce, rawBody: body });
  const ctx = executionContext({
    method: 'POST',
    url: originalUrl ? '/rewritten' : SIGNED_PATH,
    rawBody: Buffer.from(body),
    headers: {
      authorization: `Bearer ${rawKey}`,
      'x-octap-timestamp': String(timestamp),
      'x-octap-nonce': nonce,
      'x-octap-signature': signature ?? signCanonicalRequest(canonical, signingKey),
    },
    handler: route(RequireSignedRequest()),
  });
  if (originalUrl) {
    ctx.request.originalUrl = originalUrl;
  }
  return ctx;
}

describe('ApiKeyGuard: authentication', () => {
  it('a valid key attaches the tenant context, touches lastUsedAt, and passes', async () => {
    const findByKeyHash = vi.fn(async (hash: string) => (hash === hashApiKey('octap_live_valid') ? activeCredential() : undefined));
    const touchLastUsed = vi.fn(async () => {});
    const g = new ApiKeyGuard(stub<ApiCredentialsRepository>({ findByKeyHash, touchLastUsed }), new Reflector(), fakeRedis());
    const ctx = executionContext({ headers: { authorization: 'Bearer octap_live_valid' } });

    expect(await g.canActivate(ctx)).toBe(true);
    expect(ctx.request.tenant).toEqual({ organizationId: 'org-1', credentialId: 'cred-1', scopes: ['read', 'write'] });
    expect(touchLastUsed).toHaveBeenCalledWith('cred-1');
  });

  it('accepts a matching x-organization-id header', async () => {
    const ctx = executionContext({ headers: { authorization: 'Bearer k', 'x-organization-id': 'org-1' } });
    expect(await guard(activeCredential()).canActivate(ctx)).toBe(true);
  });

  it.each([
    ['no Authorization header', {}],
    ['a non-Bearer scheme', { authorization: 'Basic abc' }],
    ['an empty Bearer token', { authorization: 'Bearer    ' }],
  ])('rejects %s', async (_label, headers) => {
    await expect(guard(activeCredential()).canActivate(executionContext({ headers }))).rejects.toMatchObject({
      name: 'UnauthorizedException',
      message: expect.stringMatching(/Missing API credential/),
    });
  });

  it.each([
    ['unknown', undefined],
    ['revoked', { status: 'REVOKED' }],
  ])('rejects an %s key', async (_label, credential) => {
    await expect(guard(credential).canActivate(executionContext({ headers: { authorization: 'Bearer k' } }))).rejects.toThrow(
      /invalid or has been revoked/,
    );
  });

  it('rejects an expired key, but accepts one expiring in the future', async () => {
    const ctx = () => executionContext({ headers: { authorization: 'Bearer k' } });
    await expect(guard(activeCredential({ expiresAt: new Date(Date.now() - 1000) })).canActivate(ctx())).rejects.toThrow(/expired/);
    expect(await guard(activeCredential({ expiresAt: new Date(Date.now() + 60_000) })).canActivate(ctx())).toBe(true);
  });

  it('rejects a stolen key replayed with a different org header (anti cross-tenant spoofing)', async () => {
    const ctx = executionContext({ headers: { authorization: 'Bearer octap_live_org1key', 'x-organization-id': 'org-2' } });
    await expect(guard(activeCredential()).canActivate(ctx)).rejects.toMatchObject({
      name: 'ForbiddenException',
      message: expect.stringMatching(/does not match this API credential/),
    });
  });
});

describe('ApiKeyGuard: @Public()', () => {
  it('lets a public route through without any credential, never touching the repository or Redis', async () => {
    const findByKeyHash = vi.fn();
    const g = new ApiKeyGuard(stub<ApiCredentialsRepository>({ findByKeyHash }), new Reflector(), stub<Redis>());

    expect(await g.canActivate(executionContext({ handler: route(Public()) }))).toBe(true);
    expect(findByKeyHash).not.toHaveBeenCalled();
  });

  it('honours @Public() on the controller class', async () => {
    @Public()
    class CustomerController {}

    const ctx = executionContext({ klass: CustomerController });
    expect(await guard(undefined).canActivate(ctx)).toBe(true);
    expect(ctx.request.tenant).toBeUndefined();
  });

  it('marks exactly the customer-device routes public', () => {
    const isPublic = (target: object) => Reflect.getMetadata(IS_PUBLIC_KEY, target) === true;
    expect(isPublic(IdentityController)).toBe(true);
    expect(isPublic(CreditsController.prototype.finalizePosRedemption)).toBe(true);
    for (const merchantRoute of ['earn', 'redeem', 'reservePosRedemption', 'reverseTransaction', 'getBalance', 'getTransactions'] as const) {
      expect(isPublic(CreditsController.prototype[merchantRoute]), merchantRoute).toBe(false);
    }
    expect(isPublic(CreditsController)).toBe(false);
  });
});

describe('ApiKeyGuard: scopes', () => {
  it('blocks a write attempt from a read-only credential (privilege escalation)', async () => {
    const writeRoute = route(Scopes('write'));
    expect(Reflect.getMetadata(SCOPES_KEY, writeRoute)).toEqual(['write']);

    const ctx = executionContext({ headers: { authorization: 'Bearer k' }, handler: writeRoute });
    await expect(guard(activeCredential({ scopes: ['read'] })).canActivate(ctx)).rejects.toThrow(/missing the required "write" scope/);
  });

  it('honours class-level scopes when the handler declares none', async () => {
    @Scopes('admin')
    class AdminController {}

    const ctx = executionContext({ headers: { authorization: 'Bearer k' }, klass: AdminController });
    await expect(guard(activeCredential()).canActivate(ctx)).rejects.toThrow(/"admin" scope/);
  });

  it('passes when the credential holds every required scope', async () => {
    const ctx = executionContext({ headers: { authorization: 'Bearer k' }, handler: route(Scopes('read', 'write')) });
    expect(await guard(activeCredential()).canActivate(ctx)).toBe(true);
  });
});

describe('ApiKeyGuard: rate limiting', () => {
  it('rejects once the per-credential rate limit is exceeded', async () => {
    const g = guard(activeCredential());
    const ctx = () => executionContext({ headers: { authorization: 'Bearer octap_live_ratelimited' } });

    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
      expect(await g.canActivate(ctx())).toBe(true);
    }
    await expect(g.canActivate(ctx())).rejects.toThrow(/Rate limit exceeded/);
  });

  it('fails closed (503) when Redis is unreachable for rate limiting', async () => {
    const brokenRedis = stub<Redis>({
      incr: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await expect(guard(activeCredential(), brokenRedis).canActivate(executionContext({ headers: { authorization: 'Bearer k' } }))).rejects.toMatchObject({
      name: 'ServiceUnavailableException',
      message: expect.stringMatching(/Rate limiting is temporarily unavailable/),
    });
  });
});

describe('ApiKeyGuard: signed requests', () => {
  const admin = activeCredential({ scopes: ['admin'] });

  it('the decorator marks the route', () => {
    expect(Reflect.getMetadata(REQUIRE_SIGNED_REQUEST_KEY, route(RequireSignedRequest()))).toBe(true);
  });

  it('a correctly signed request on a @RequireSignedRequest() route passes', async () => {
    expect(await guard(admin).canActivate(signedContext())).toBe(true);
  });

  it('signs over originalUrl when a router rewrote url', async () => {
    expect(await guard(admin).canActivate(signedContext({ originalUrl: SIGNED_PATH }))).toBe(true);
  });

  it('verifies an empty body when the request carries no rawBody', async () => {
    const ctx = signedContext({ body: '' });
    ctx.request.rawBody = undefined;
    expect(await guard(admin).canActivate(ctx)).toBe(true);
  });

  it.each(['x-octap-timestamp', 'x-octap-nonce', 'x-octap-signature'])('rejects a request missing %s', async (header) => {
    const ctx = signedContext();
    delete ctx.request.headers[header];
    await expect(guard(admin).canActivate(ctx)).rejects.toThrow(/requires a signed request/);
  });

  it('rejects a tampered signature', async () => {
    await expect(guard(admin).canActivate(signedContext({ signature: 'a'.repeat(64) }))).rejects.toThrow(/Invalid request signature/);
  });

  it('rejects a body changed after signing', async () => {
    const ctx = signedContext();
    ctx.request.rawBody = Buffer.from('{"scopes":["admin"]}');
    await expect(guard(admin).canActivate(ctx)).rejects.toThrow(/Invalid request signature/);
  });

  it.each([
    ['stale', Math.floor(Date.now() / 1000) - 10_000],
    ['from the future', Math.floor(Date.now() / 1000) + 10_000],
    ['malformed', 'yesterday'],
  ])('rejects a %s timestamp (outside the replay window)', async (_label, timestamp) => {
    await expect(guard(admin).canActivate(signedContext({ timestamp }))).rejects.toThrow(/outside the replay window/);
  });

  it('rejects a replayed (already-used) nonce', async () => {
    const g = guard(admin);
    expect(await g.canActivate(signedContext({ nonce: 'reused-nonce' }))).toBe(true);
    await expect(g.canActivate(signedContext({ nonce: 'reused-nonce' }))).rejects.toThrow(/already used, or replay protection is unavailable/);
  });

  it('a forged request cannot burn someone else’s nonce', async () => {
    const g = guard(admin);
    await expect(g.canActivate(signedContext({ nonce: 'victim-nonce', signature: 'b'.repeat(64) }))).rejects.toThrow(/Invalid/);
    expect(await g.canActivate(signedContext({ nonce: 'victim-nonce' }))).toBe(true);
  });

  it('fails closed when Redis is unreachable for nonce claims', async () => {
    const brokenNonceRedis = stub<Redis>({
      incr: async () => 1,
      expire: async () => 1,
      set: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await expect(guard(admin, brokenNonceRedis).canActivate(signedContext())).rejects.toThrow(/replay protection is unavailable/);
  });

  it('rotating a credential invalidates signatures made with the old signing key', async () => {
    // After rotation the old raw key no longer resolves an ACTIVE credential at all, so the request
    // is rejected at the bearer-auth step, before signature verification even runs.
    await expect(guard(undefined).canActivate(signedContext({ rawKey: 'octap_live_before_rotation' }))).rejects.toThrow(
      /invalid or has been revoked/,
    );
  });

  it('does not require signing on an unmarked route', async () => {
    expect(await guard(admin).canActivate(executionContext({ headers: { authorization: 'Bearer k' } }))).toBe(true);
  });
});
