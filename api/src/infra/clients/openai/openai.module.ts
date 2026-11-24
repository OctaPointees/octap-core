import { Module } from '@nestjs/common';
import { OpenAiAssistantClient } from './openai-assistant.client.js';

/** The OpenAI Responses API, the dashboard assistant's second provider (OCT-308). `OPENAI_API_KEY` is read on first use. */
@Module({
  providers: [OpenAiAssistantClient],
  exports: [OpenAiAssistantClient],
})
export class OpenAiModule {}
