import { Module } from '@nestjs/common';
import { PostgresModule } from './postgres/postgres.module.js';
import { RedisModule } from './redis/redis.module.js';
import { SuiModule } from './sui/sui.module.js';
import { EnokiModule } from './enoki/enoki.module.js';
import { ClickhouseModule } from './clickhouse/clickhouse.module.js';
import { WalrusModule } from './walrus/walrus.module.js';
import { SealModule } from './seal/seal.module.js';
import { StripeModule } from './stripe/stripe.module.js';
import { MerchantWebhooksModule } from './merchant-webhooks/merchant-webhooks.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
const integrationModules = [PostgresModule, RedisModule, SuiModule, EnokiModule, ClickhouseModule, WalrusModule, SealModule, StripeModule, MerchantWebhooksModule, RealtimeModule];
@Module({ imports: integrationModules, exports: integrationModules })
export class InfrastructureModule {}
