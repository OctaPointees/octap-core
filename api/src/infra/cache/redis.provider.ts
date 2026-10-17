import { type Provider } from '@nestjs/common';
import { Redis } from 'ioredis';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

export const redisClientProvider: Provider = {
  provide: REDIS_CLIENT,
  useFactory: () => {
    return new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
      // Fail fast rather than queueing commands indefinitely when Redis is down — callers
      // (nonce/replay checks, rate limiting) must see the error and fail closed, not hang.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
      // Bounded, not ioredis's default of "forever": an environment with no Redis at all
      // (e.g. CI without the service, or a misconfigured REDIS_URL) must still let the
      // process shut down cleanly on app.close() instead of hanging on reconnect timers.
      retryStrategy: (attempt) => (attempt > 5 ? null : Math.min(attempt * 200, 2000)),
    });
  },
};
