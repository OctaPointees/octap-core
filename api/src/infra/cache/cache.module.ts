import { Module } from '@nestjs/common';
import { REDIS_CLIENT, RedisLifecycle, redisClientProvider } from './redis.provider.js';

@Module({
  providers: [redisClientProvider, RedisLifecycle],
  exports: [REDIS_CLIENT],
})
export class CacheModule {}
