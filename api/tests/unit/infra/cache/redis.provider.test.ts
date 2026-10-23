import { describe, expect, it, vi } from 'vitest';
import type { FactoryProvider } from '@nestjs/common';
import type { Redis, RedisOptions } from 'ioredis';
import { RedisLifecycle, redisClientProvider } from '#infra/cache/redis.provider.js';
import { stub } from '../../../helpers/stub.js';

describe('redisClientProvider', () => {
  it('fails fast and gives up reconnecting so a missing Redis can’t hang the process', () => {
    // An unroutable port: the client starts connecting, and is torn down before it can retry.
    vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:1');
    const client = (redisClientProvider as FactoryProvider<Redis>).useFactory() as Redis;
    client.on('error', () => {});
    try {
      const options = client.options as RedisOptions;
      expect(options.maxRetriesPerRequest).toBe(1);
      expect(options.enableOfflineQueue).toBe(false);
      expect(options.port).toBe(1);
      expect(options.retryStrategy?.(1)).toBe(200);
      expect(options.retryStrategy?.(5)).toBe(1000);
      expect(options.retryStrategy?.(6)).toBeNull();
    } finally {
      client.disconnect();
    }
  });
});

describe('RedisLifecycle', () => {
  it('disconnects the client on module destroy so app.close() can exit', () => {
    const disconnect = vi.fn();
    new RedisLifecycle(stub<Redis>({ disconnect })).onModuleDestroy();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
