import { Module } from '@nestjs/common';
import { CacheModule } from '#infra/cache/cache.module.js';
import { AnthropicModule } from '#infra/clients/anthropic/anthropic.module.js';
import { OpenAiModule } from '#infra/clients/openai/openai.module.js';
import { McpAuthModule } from '../mcp-auth/mcp-auth.module.js';
import { AssistantService } from './assistant.service.js';

@Module({
  imports: [CacheModule, AnthropicModule, OpenAiModule, McpAuthModule],
  providers: [AssistantService],
  exports: [AssistantService],
})
export class AssistantModule {}
