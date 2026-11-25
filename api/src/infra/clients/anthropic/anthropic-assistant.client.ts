import { Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { requireEnv } from '../require-env.js';
import type {
  AssistantModelClient,
  AssistantRunEvent,
  AssistantRunRequest,
  AssistantUsage,
} from '../assistant-model.js';

/** Claude Opus 5.5 with adaptive thinking (always on for this model) and an explicit effort. */
export const ASSISTANT_MODEL = 'claude-opus-5-5';
const EFFORT = 'medium';
/** A cost cap per model call, not a quality setting: a chat answer about one organization is short. */
const MAX_TOKENS = 16_000;
const MCP_SERVER_NAME = 'octap';
/** The MCP connector, and the server-side fallback that reruns a refused request on another model. */
const BETAS = ['mcp-client-2025-11-20', 'server-side-fallback-2026-07-01'];
/** Long tool loops come back as `pause_turn`; each one is resumed by sending the answer so far. */
const MAX_CONTINUATIONS = 3;

/** The part of a `BetaMessageStream` the client uses, so tests can stand in for the SDK. */
export interface ModelStream extends AsyncIterable<BetaRawMessageStreamEvent> {
  finalMessage(): Promise<BetaMessage>;
  abort(): void;
}

/**
 * The Claude Messages API with the MCP connector (OCT-308). Claude calls the OctaP MCP server
 * itself, from Anthropic's side, with the token in `mcp.token`; Core only streams what comes back.
 */
@Injectable()
export class AnthropicAssistantClient implements AssistantModelClient {
  private sdk?: Anthropic;

  async *run(request: AssistantRunRequest): AsyncGenerator<AssistantRunEvent> {
    const messages: BetaMessageParam[] = request.messages.map((turn) => ({ role: turn.role, content: turn.text }));
    const usage: AssistantUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, modelCalls: 0 };
    let toolCalls = 0;

    for (let call = 0; call <= MAX_CONTINUATIONS; call++) {
      const stream = this.open(
        {
          model: ASSISTANT_MODEL,
          max_tokens: MAX_TOKENS,
          betas: BETAS,
          fallbacks: 'default',
          thinking: { type: 'adaptive' },
          output_config: { effort: EFFORT },
          // The system prompt and tool list are the same for every turn of one user's conversation.
          cache_control: { type: 'ephemeral' },
          system: request.system,
          mcp_servers: [
            { type: 'url', url: request.mcp.url, name: MCP_SERVER_NAME, authorization_token: request.mcp.token },
          ],
          tools: [{ type: 'mcp_toolset', mcp_server_name: MCP_SERVER_NAME }],
          messages,
        },
        request.signal,
      );
      usage.modelCalls++;

      let overLimit = false;
      // What the stream itself reports, for a call cut off before `finalMessage`: input and cache
      // reads arrive with `message_start`, output (cumulative) with each `message_delta`.
      const streamed = { input: 0, output: 0, cacheRead: 0 };
      for await (const event of stream) {
        if (event.type === 'message_start') {
          streamed.input = event.message.usage.input_tokens;
          streamed.cacheRead = event.message.usage.cache_read_input_tokens ?? 0;
        } else if (event.type === 'message_delta') {
          streamed.input = event.usage.input_tokens ?? streamed.input;
          streamed.cacheRead = event.usage.cache_read_input_tokens ?? streamed.cacheRead;
          streamed.output = event.usage.output_tokens;
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'text', text: event.delta.text };
        } else if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (block.type === 'mcp_tool_use') {
            toolCalls++;
            if (toolCalls > request.maxToolCalls) {
              overLimit = true;
              stream.abort();
              break;
            }
            yield { type: 'tool_call', id: block.id, name: block.name };
          } else if (block.type === 'mcp_tool_result') {
            yield { type: 'tool_result', toolUseId: block.tool_use_id, isError: block.is_error };
          } else if (block.type === 'fallback') {
            yield { type: 'fallback', from: block.from.model, to: block.to.model };
          }
        }
      }
      if (overLimit) {
        usage.inputTokens += streamed.input;
        usage.outputTokens += streamed.output;
        usage.cacheReadTokens += streamed.cacheRead;
        usage.partial = true;
        yield { type: 'end', reason: 'tool_limit', usage };
        return;
      }

      const message = await stream.finalMessage();
      usage.inputTokens += message.usage.input_tokens;
      usage.outputTokens += message.usage.output_tokens;
      usage.cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;

      if (message.stop_reason === 'refusal') {
        yield { type: 'refusal', category: message.stop_details?.category ?? null };
        yield { type: 'end', reason: 'refused', usage };
        return;
      }
      if (message.stop_reason === 'pause_turn') {
        // Resume: the answer so far goes back unchanged, and the API carries on from it.
        messages.push({ role: 'assistant', content: message.content as BetaContentBlock[] as never });
        continue;
      }
      const reason =
        message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded'
          ? 'length'
          : 'complete';
      yield { type: 'end', reason, usage };
      return;
    }
    // Still paused after every continuation: the turn ran out of steps, not of tool calls.
    yield { type: 'end', reason: 'turn_limit', usage };
  }

  /** Opens one streamed model call. Tests replace this. */
  protected open(params: BetaMessageStreamParams, signal: AbortSignal): ModelStream {
    this.sdk ??= new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY', 'dashboard assistant') });
    return this.sdk.beta.messages.stream(params, { signal });
  }
}
