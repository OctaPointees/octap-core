import { Module } from '@nestjs/common';
import { PostgresModule } from './db/postgres.module.js';
import { RedisModule } from './cache/redis.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { QueueModule } from './queue/queue.module.js';
import { SuiModule } from './clients/sui/sui.module.js';
import { EnokiModule } from './clients/enoki/enoki.module.js';
import { ClickhouseModule } from './clients/clickhouse/clickhouse.module.js';
import { WalrusModule } from './clients/walrus/walrus.module.js';
import { SealModule } from './clients/seal/seal.module.js';
import { StripeModule } from './clients/stripe/stripe.module.js';
import { MerchantWebhooksModule } from './clients/merchant-webhooks/merchant-webhooks.module.js';
const integrationModules = [PostgresModule, RedisModule, RealtimeModule, QueueModule, SuiModule, EnokiModule, ClickhouseModule, WalrusModule, SealModule, StripeModule, MerchantWebhooksModule];
@Module({ imports: integrationModules, exports: integrationModules })
export class InfrastructureModule {}
