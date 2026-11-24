import { Module } from '@nestjs/common';
import { AnthropicAssistantClient } from './anthropic-assistant.client.js';

/** The Claude Messages API, for the dashboard assistant (OCT-308). `ANTHROPIC_API_KEY` is read on first use. */
@Module({
  providers: [AnthropicAssistantClient],
  exports: [AnthropicAssistantClient],
})
export class AnthropicModule {}
