import { HttpException, ServiceUnavailableException, type ExecutionContext } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import {
  PUBLIC_RATE_LIMIT_MAX_REQUESTS,
  PublicRateLimitGuard,
  parseTrustedProxyHops,
  rateLimitSubjectForIp,
} from '#infra/auth/public-rate-limit.guard.js';
import { fakeRedis } from '../../../helpers/redis.js';
import { stub } from '../../../helpers/stub.js';

const response = { setHeader: vi.fn() };
const contextFrom = (ip?: string) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ ip }), getResponse: () => response }),
  }) as unknown as ExecutionContext;

describe('PublicRateLimitGuard', () => {
  it('allows the limit per address, then answers 429', async () => {
    const guard = new PublicRateLimitGuard(fakeRedis());
    for (let i = 0; i < PUBLIC_RATE_LIMIT_MAX_REQUESTS; i++) {
      await expect(guard.canActivate(contextFrom('203.0.113.1'))).resolves.toBe(true);
    }

    const rejected = await guard.canActivate(contextFrom('203.0.113.1')).catch((err: unknown) => err);

    expect(rejected).toBeInstanceOf(HttpException);
    expect((rejected as HttpException).getStatus()).toBe(429);
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', expect.stringMatching(/^\d+$/));
    await expect(guard.canActivate(contextFrom('203.0.113.2'))).resolves.toBe(true);
  });

  it('fails closed when Redis is unreachable', async () => {
    const guard = new PublicRateLimitGuard(
      stub<Redis>({
        incr: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    );
    await expect(guard.canActivate(contextFrom('203.0.113.1'))).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('rateLimitSubjectForIp', () => {
  it.each([
    ['203.0.113.1', 'public-ip:203.0.113.1'],
    ['::ffff:203.0.113.1', 'public-ip:203.0.113.1'],
    [undefined, 'public-ip:unknown'],
    ['::1', 'public-ip:0:0:0:0::/64'],
    ['2001:db8:1:2:3:4:5:6', 'public-ip:2001:db8:1:2::/64'],
    ['2001:0DB8:0001:0002::9', 'public-ip:2001:db8:1:2::/64'],
    ['fe80::1%eth0', 'public-ip:fe80:0:0:0::/64'],
  ])('maps %s to %s', (ip, subject) => {
    expect(rateLimitSubjectForIp(ip)).toBe(subject);
  });

  it('counts every address in one IPv6 /64 as one client', () => {
    expect(rateLimitSubjectForIp('2001:db8:1:2::a')).toBe(rateLimitSubjectForIp('2001:db8:1:2:ffff::b'));
  });
});

describe('parseTrustedProxyHops', () => {
  it('defaults to trusting no proxy', () => {
    expect(parseTrustedProxyHops(undefined)).toBe(0);
  });

  it('accepts a hop count', () => {
    expect(parseTrustedProxyHops('2')).toBe(2);
  });

  it.each(['true', '-1', '1.5'])('refuses %s', (value) => {
    expect(() => parseTrustedProxyHops(value)).toThrow(/TRUSTED_PROXY_HOPS/);
  });
});
