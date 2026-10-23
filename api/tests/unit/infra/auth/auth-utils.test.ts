import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import type { Redis } from 'ioredis';
import { API_KEY_PREFIX, generateApiKey, hashApiKey } from '../../../../src/infra/auth/api-key-hash.util.js';
import {
  REPLAY_WINDOW_SECONDS,
  buildCanonicalRequest,
  hashBody,
  isTimestampFresh,
  signCanonicalRequest,
  verifyCanonicalSignature,
} from '../../../../src/infra/auth/request-signing.util.js';
import {
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_SECONDS,
  checkRateLimit,
} from '../../../../src/infra/auth/rate-limit.util.js';
import { claimNonce } from '../../../../src/infra/auth/nonce-store.util.js';
import { Tenant } from '../../../../src/infra/auth/tenant.decorator.js';
import { stub } from '../../../helpers/stub.js';
import { fakeRedis } from '../../../helpers/redis.js';

describe('api-key-hash', () => {
  it('generates prefixed random keys and hashes them with SHA-256', () => {
    const key = generateApiKey();
    expect(key.raw.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(key.prefix).toHaveLength(API_KEY_PREFIX.length + 8);
    expect(key.hash).toBe(hashApiKey(key.raw));
    expect(hashApiKey('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(generateApiKey().raw).not.toBe(key.raw);
  });
});

describe('request-signing', () => {
  it('the canonical form is method/path/timestamp/nonce/body-hash, newline separated, method upper-cased', () => {
    expect(
      buildCanonicalRequest({ method: 'post', path: '/v1/x?a=1', timestamp: '100', nonce: 'n', rawBody: '{}' }),
    ).toBe(`POST\n/v1/x?a=1\n100\nn\n${hashBody('{}')}`);
  });

  it('verifies its own signature and rejects a different key, length, or non-hex signature', () => {
    const canonical = buildCanonicalRequest({ method: 'GET', path: '/', timestamp: '1', nonce: 'n', rawBody: '' });
    const signature = signCanonicalRequest(canonical, 'key-1');

    expect(verifyCanonicalSignature(canonical, signature, 'key-1')).toBe(true);
    expect(verifyCanonicalSignature(canonical, signature, 'key-2')).toBe(false);
    expect(verifyCanonicalSignature(canonical, signature.slice(2), 'key-1')).toBe(false);
    expect(verifyCanonicalSignature(canonical, 'zz'.repeat(32), 'key-1')).toBe(false);
  });

  it('treats timestamps within the replay window (either direction) as fresh', () => {
    const now = 1_000_000;
    expect(isTimestampFresh(now, now)).toBe(true);
    expect(isTimestampFresh(now - REPLAY_WINDOW_SECONDS, now)).toBe(true);
    expect(isTimestampFresh(now + REPLAY_WINDOW_SECONDS, now)).toBe(true);
    expect(isTimestampFresh(now - REPLAY_WINDOW_SECONDS - 1, now)).toBe(false);
    expect(isTimestampFresh(now + REPLAY_WINDOW_SECONDS + 1, now)).toBe(false);
    expect(isTimestampFresh(Math.floor(Date.now() / 1000))).toBe(true);
  });
});

describe('checkRateLimit', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts per credential per fixed window and sets the TTL on the first hit only', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-23T00:00:30Z') });
    const redis = fakeRedis();
    const expire = vi.spyOn(redis, 'expire');

    expect(await checkRateLimit(redis, 'cred-1')).toBe('allowed');
    expect(await checkRateLimit(redis, 'cred-1')).toBe('allowed');
    expect(expire).toHaveBeenCalledOnce();
    const [key, ttl] = expire.mock.calls[0];
    expect(key).toBe(`ratelimit:cred-1:${Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW_SECONDS)}`);
    expect(ttl).toBe(RATE_LIMIT_WINDOW_SECONDS);
  });

  it('allows exactly RATE_LIMIT_MAX_REQUESTS, then reports exceeded; a new window resets', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-23T00:00:00Z') });
    const redis = fakeRedis();
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
      expect(await checkRateLimit(redis, 'cred-1')).toBe('allowed');
    }
    expect(await checkRateLimit(redis, 'cred-1')).toBe('exceeded');
    expect(await checkRateLimit(redis, 'cred-2')).toBe('allowed');

    vi.setSystemTime(new Date('2026-10-23T00:01:00Z'));
    expect(await checkRateLimit(redis, 'cred-1')).toBe('allowed');
  });

  it('reports unavailable (never allowed) when Redis throws', async () => {
    const broken = stub<Redis>({
      incr: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(await checkRateLimit(broken, 'cred-1')).toBe('unavailable');
  });
});

describe('claimNonce', () => {
  it('claims a nonce once per credential for the replay window', async () => {
    const redis = fakeRedis();
    expect(await claimNonce(redis, 'cred-1', 'n1')).toBe(true);
    expect(await claimNonce(redis, 'cred-1', 'n1')).toBe(false);
    expect(await claimNonce(redis, 'cred-2', 'n1')).toBe(true);
    expect(redis.ttls.get('nonce:cred-1:n1')).toBe(REPLAY_WINDOW_SECONDS);
  });

  it('fails closed when Redis throws', async () => {
    const broken = stub<Redis>({
      set: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(await claimNonce(broken, 'cred-1', 'n1')).toBe(false);
  });
});

describe('@Tenant()', () => {
  it('reads the tenant context ApiKeyGuard attached to the request', () => {
    class Controller {
      handler(@Tenant() tenant: unknown) {
        return tenant;
      }
    }
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, Controller, 'handler') as Record<
      string,
      { factory: (data: unknown, ctx: ExecutionContext) => unknown }
    >;
    const { factory } = Object.values(args)[0];
    const tenant = { organizationId: 'org-1', credentialId: 'c', scopes: [] };
    const ctx = { switchToHttp: () => ({ getRequest: () => ({ tenant }) }) } as unknown as ExecutionContext;

    expect(factory(undefined, ctx)).toBe(tenant);
  });
});
