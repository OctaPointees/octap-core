import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import type { Redis } from 'ioredis';
import { API_KEY_PREFIX, generateApiKey, hashApiKey } from '#infra/auth/api-key-hash.util.js';
import { RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_SECONDS, checkRateLimit } from '#infra/auth/rate-limit.util.js';
import { Tenant } from '#infra/auth/tenant.decorator.js';
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
