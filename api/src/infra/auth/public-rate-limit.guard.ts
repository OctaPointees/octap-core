import { CanActivate, ExecutionContext, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { isIPv6 } from 'node:net';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../cache/redis.provider.js';
import { checkRateLimit, rateLimitExceeded } from './rate-limit.util.js';

export const PUBLIC_RATE_LIMIT_MAX_REQUESTS = Number(process.env.PUBLIC_RATE_LIMIT_MAX_REQUESTS ?? 60);

/** Reads `TRUSTED_PROXY_HOPS` for Express's `trust proxy`, refusing a value that would trust every proxy. */
export function parseTrustedProxyHops(value: string | undefined): number {
  const hops = Number(value ?? 0);
  if (!Number.isInteger(hops) || hops < 0) {
    throw new Error(`TRUSTED_PROXY_HOPS must be a non-negative integer, got "${value}"`);
  }
  return hops;
}

/**
 * One customer usually holds a whole IPv6 /64, so limiting single addresses there would limit
 * nothing. An IPv4-mapped address is the same client as its IPv4 form.
 */
export function rateLimitSubjectForIp(ip: string | undefined): string {
  const address = (ip ?? 'unknown').replace(/^::ffff:/i, '');
  if (!isIPv6(address)) {
    return `public-ip:${address}`;
  }
  const [head, tail = ''] = address.split('%')[0].split('::');
  const leading = head ? head.split(':') : [];
  const trailing = tail ? tail.split(':') : [];
  const zeros = new Array<string>(Math.max(0, 8 - leading.length - trailing.length)).fill('0');
  const network = [...leading, ...zeros, ...trailing].slice(0, 4).map((group) => parseInt(group, 16).toString(16));
  return `public-ip:${network.join(':')}::/64`;
}

/**
 * The limit `ApiKeyGuard` skips on `@Public()` routes, which spend Core's Enoki key or submit
 * sponsored transactions. Like that limiter it fails closed when Redis is unreachable.
 */
@Injectable()
export class PublicRateLimitGuard implements CanActivate {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ ip?: string }>();
    const result = await checkRateLimit(this.redis, rateLimitSubjectForIp(request.ip), PUBLIC_RATE_LIMIT_MAX_REQUESTS);
    if (result === 'exceeded') {
      throw rateLimitExceeded(context, 'Too many requests from this address; try again shortly');
    }
    if (result === 'unavailable') {
      throw new ServiceUnavailableException('Rate limiting is temporarily unavailable; refusing to fail open');
    }
    return true;
  }
}
