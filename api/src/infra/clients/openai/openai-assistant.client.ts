import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import type {
  Response,
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';
import { requireEnv } from '../require-env.js';
import type {
  AssistantModelClient,
  AssistantRunEvent,
  AssistantRunRequest,
  AssistantUsage,
} from '../assistant-model.js';

/** A cost cap per model call, not a quality setting: a chat answer about one organization is short. */
const MAX_OUTPUT_TOKENS = 16_000;
const MCP_SERVER_LABEL = 'octap';

/** The part of a `ResponseStream` the client uses, so tests can stand in for the SDK. */
export interface ResponsesStream extends AsyncIterable<ResponseStreamEvent> {
  finalResponse(): Promise<Response>;
  abort(): void;
}

/** The OpenAI model the assistant uses (`OPENAI_MODEL`). Required: no default model is assumed. */
export function openAiModel(): string | null {
  return process.env.OPENAI_MODEL?.trim() || null;
}

/**
 * The OpenAI Responses API with its hosted MCP tool (OCT-308, the second provider). OpenAI calls the
 * OctaP MCP server itself with the token in `mcp.token`; Core only streams what comes back. Nothing
 * is stored on OpenAI's side (`store: false`).
 */
@Injectable()
export class OpenAiAssistantClient implements AssistantModelClient {
  private sdk?: OpenAI;

  async *run(request: AssistantRunRequest): AsyncGenerator<AssistantRunEvent> {
    const model = openAiModel();
    if (!model) throw new Error('Missing required env var OPENAI_MODEL for the dashboard assistant');
    const stream = this.open(
      {
        model,
        instructions: request.system,
        input: request.messages.map((turn) => ({ role: turn.role, content: turn.text })),
        tools: [
          {
            type: 'mcp',
            server_label: MCP_SERVER_LABEL,
            server_url: request.mcp.url,
            authorization: request.mcp.token,
            // Every OctaP tool is read-only; Core still checks each call.
            require_approval: 'never',
          },
        ],
        max_tool_calls: request.maxToolCalls,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        store: false,
        stream: true,
      },
      request.signal,
    );

    let toolCalls = 0;
    let refused = false;
    for await (const event of stream) {
      switch (event.type) {
        case 'response.output_text.delta':
          yield { type: 'text', text: event.delta };
          break;
        case 'response.output_item.added':
          if (event.item.type === 'mcp_call') {
            toolCalls++;
            if (toolCalls > request.maxToolCalls) {
              stream.abort();
              // OpenAI reports usage only with the finished response, which an aborted call never
              // gets; `max_tool_calls` normally ends the turn first, so this is the fallback.
              yield { type: 'end', reason: 'tool_limit', usage: { ...emptyUsage(), partial: true } };
              return;
            }
            yield { type: 'tool_call', id: event.item.id, name: event.item.name };
          }
          break;
        case 'response.mcp_call.completed':
          yield { type: 'tool_result', toolUseId: event.item_id, isError: false };
          break;
        case 'response.mcp_call.failed':
          yield { type: 'tool_result', toolUseId: event.item_id, isError: true };
          break;
        case 'response.mcp_list_tools.failed':
          // The token was refused before any tool ran, e.g. the user's access changed.
          throw new Error('The MCP server refused to list its tools');
        case 'response.refusal.delta':
          refused = true;
          break;
        case 'response.failed':
          throw new Error(`OpenAI response failed: ${event.response.error?.code ?? 'unknown'}`);
        case 'error':
          throw new Error(`OpenAI stream error: ${event.code ?? 'unknown'}`);
      }
    }

    const response = await stream.finalResponse();
    const usage: AssistantUsage = {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      cacheReadTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
      modelCalls: 1,
    };
    const incomplete = response.status === 'incomplete' ? response.incomplete_details?.reason : undefined;
    if (refused || incomplete === 'content_filter') {
      yield { type: 'refusal', category: incomplete === 'content_filter' ? 'content_filter' : null };
      yield { type: 'end', reason: 'refused', usage };
      return;
    }
    yield { type: 'end', reason: incomplete === 'max_output_tokens' ? 'length' : 'complete', usage };
  }

  /** Opens one streamed model call. Tests replace this. */
  protected open(params: ResponseCreateParamsStreaming, signal: AbortSignal): ResponsesStream {
    this.sdk ??= new OpenAI({ apiKey: requireEnv('OPENAI_API_KEY', 'dashboard assistant') });
    return this.sdk.responses.stream(params, { signal });
  }
}

function emptyUsage(): AssistantUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, modelCalls: 1 };
}
