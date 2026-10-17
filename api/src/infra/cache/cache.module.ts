import { Module } from '@nestjs/common';
import { REDIS_CLIENT, redisClientProvider } from './redis.provider.js';

@Module({
  providers: [redisClientProvider],
  exports: [REDIS_CLIENT],
})
export class CacheModule {}
