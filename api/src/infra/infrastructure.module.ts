import { Module } from '@nestjs/common';
import { PostgresModule } from './db/postgres.module.js';
import { EnokiModule } from './clients/enoki/enoki.module.js';
import { SuiTransactionBuilderModule } from './clients/sui/sui-transaction-builder.module.js';
import { AnthropicModule } from './clients/anthropic/anthropic.module.js';
import { OpenAiModule } from './clients/openai/openai.module.js';
const integrationModules = [PostgresModule, EnokiModule, SuiTransactionBuilderModule, AnthropicModule, OpenAiModule];
@Module({ imports: integrationModules, exports: integrationModules })
export class InfrastructureModule {}
