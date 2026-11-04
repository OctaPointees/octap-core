import { HttpException, HttpStatus, type ExecutionContext } from '@nestjs/common';
import type { Redis } from 'ioredis';

export const RATE_LIMIT_WINDOW_SECONDS = 60;
export const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? 120);

export type RateLimitResult = 'allowed' | 'exceeded' | 'unavailable';

/**
 * Fixed-window counter per subject (a credential id, or a client IP key on public routes). `'unavailable'` (Redis unreachable) is kept distinct
 * from `'exceeded'` only so callers can log/report differently — both must still reject the
 * request. Fixed windows can under-count by up to 2x at a window boundary versus a sliding
 * window; acceptable here, not acceptable to silently skip the limit when Redis is down.
 */
export async function checkRateLimit(
  redis: Redis,
  subject: string,
  maxRequests: number = RATE_LIMIT_MAX_REQUESTS,
): Promise<RateLimitResult> {
  const windowBucket = Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW_SECONDS);
  const key = `ratelimit:${subject}:${windowBucket}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, RATE_LIMIT_WINDOW_SECONDS);
    }
    return count <= maxRequests ? 'allowed' : 'exceeded';
  } catch {
    return 'unavailable';
  }
}

/** The 429 for an exhausted window. Without a hint, clients retry at once and keep the window full. */
export function rateLimitExceeded(context: ExecutionContext, message: string): HttpException {
  const secondsLeft = RATE_LIMIT_WINDOW_SECONDS - Math.floor((Date.now() / 1000) % RATE_LIMIT_WINDOW_SECONDS);
  context
    .switchToHttp()
    .getResponse<{ setHeader(name: string, value: string): void }>()
    .setHeader('Retry-After', String(secondsLeft));
  return new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);
}
