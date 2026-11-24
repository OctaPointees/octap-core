import { describe, expect, it } from 'vitest';
import type {
  BetaMessage,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { AnthropicAssistantClient, type ModelStream } from '#infra/clients/anthropic/anthropic-assistant.client.js';
import type { AssistantRunEvent, AssistantRunRequest } from '#infra/clients/assistant-model.js';

type Step = BetaRawMessageStreamEvent;
interface Call {
  events: Step[];
  final: Partial<BetaMessage>;
}

const text = (value: string): Step =>
  ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } }) as Step;
const toolUse = (id: string, name: string): Step =>
  ({
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'mcp_tool_use', id, name, server_name: 'octap', input: {} },
  }) as Step;
const toolResult = (toolUseId: string, isError: boolean): Step =>
  ({
    type: 'content_block_start',
    index: 2,
    content_block: { type: 'mcp_tool_result', tool_use_id: toolUseId, is_error: isError, content: [] },
  }) as Step;
const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80 };

/** The client with the SDK replaced by scripted model calls. */
class ScriptedClient extends AnthropicAssistantClient {
  readonly params: BetaMessageStreamParams[] = [];
  aborted = 0;
  constructor(private readonly calls: Call[]) {
    super();
  }
  protected override open(params: BetaMessageStreamParams): ModelStream {
    // Copy: the client keeps appending to the same messages array.
    this.params.push({ ...params, messages: [...params.messages] });
    const call = this.calls.shift();
    if (!call) throw new Error('unexpected model call');
    return {
      async *[Symbol.asyncIterator]() {
        yield* call.events;
      },
      finalMessage: async () => ({ content: [], usage, stop_details: null, ...call.final }) as BetaMessage,
      abort: () => {
        this.aborted++;
      },
    };
  }
}

const request = (overrides: Partial<AssistantRunRequest> = {}): AssistantRunRequest => ({
  system: 'system prompt',
  messages: [
    { role: 'user', text: 'Who is Lan?' },
    { role: 'assistant', text: 'A member.' },
    { role: 'user', text: 'Her balance?' },
  ],
  mcp: { url: 'https://mcp.octap.test/mcp', token: 'octap_mcp_secret' },
  maxToolCalls: 5,
  signal: new AbortController().signal,
  ...overrides,
});

async function collect(client: AnthropicAssistantClient, req = request()) {
  const events: AssistantRunEvent[] = [];
  for await (const event of client.run(req)) events.push(event);
  return events;
}

describe('AnthropicAssistantClient (OCT-308)', () => {
  it('asks Claude Opus 5.5 to read the OctaP MCP server with the turn token, and streams the answer', async () => {
    const client = new ScriptedClient([
      {
        events: [toolUse('t1', 'find_member'), toolResult('t1', false), text('Lan has '), text('42 points.')],
        final: { stop_reason: 'end_turn' },
      },
    ]);
    const events = await collect(client);

    expect(client.params).toHaveLength(1);
    expect(client.params[0]).toMatchObject({
      model: 'claude-opus-5-5',
      betas: ['mcp-client-2025-11-20', 'server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: 'system prompt',
      mcp_servers: [
        { type: 'url', url: 'https://mcp.octap.test/mcp', name: 'octap', authorization_token: 'octap_mcp_secret' },
      ],
      tools: [{ type: 'mcp_toolset', mcp_server_name: 'octap' }],
      messages: [
        { role: 'user', content: 'Who is Lan?' },
        { role: 'assistant', content: 'A member.' },
        { role: 'user', content: 'Her balance?' },
      ],
    });
    expect(events).toEqual([
      { type: 'tool_call', id: 't1', name: 'find_member' },
      { type: 'tool_result', toolUseId: 't1', isError: false },
      { type: 'text', text: 'Lan has ' },
      { type: 'text', text: '42 points.' },
      {
        type: 'end',
        reason: 'complete',
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, modelCalls: 1 },
      },
    ]);
  });

  it('stops the turn at the tool-call limit', async () => {
    const client = new ScriptedClient([
      {
        events: [toolUse('t1', 'find_member'), toolUse('t2', 'get_member'), toolUse('t3', 'list_vouchers')],
        final: { stop_reason: 'end_turn' },
      },
    ]);
    const events = await collect(client, request({ maxToolCalls: 2 }));
    expect(events.map((event) => event.type)).toEqual(['tool_call', 'tool_call', 'end']);
    expect(events.at(-1)).toMatchObject({ type: 'end', reason: 'tool_limit' });
    expect(client.aborted).toBe(1);
  });

  it('resumes a paused turn by sending the answer so far back', async () => {
    const paused = [{ type: 'text', text: 'Looking…', citations: null }];
    const client = new ScriptedClient([
      { events: [text('Looking…')], final: { stop_reason: 'pause_turn', content: paused as BetaMessage['content'] } },
      { events: [text(' done.')], final: { stop_reason: 'end_turn' } },
    ]);
    const events = await collect(client);
    expect(client.params).toHaveLength(2);
    expect(client.params[1].messages.at(-1)).toEqual({ role: 'assistant', content: paused });
    expect(events.at(-1)).toMatchObject({
      type: 'end',
      reason: 'complete',
      usage: { inputTokens: 200, outputTokens: 40, modelCalls: 2 },
    });
  });

  it('reports a refusal with its category, and a cut-off answer as length', async () => {
    const refused = await collect(
      new ScriptedClient([
        {
          events: [],
          final: {
            stop_reason: 'refusal',
            stop_details: { type: 'refusal', category: 'cyber', explanation: null } as BetaMessage['stop_details'],
          },
        },
      ]),
    );
    expect(refused.slice(0, 2)).toEqual([
      { type: 'refusal', category: 'cyber' },
      expect.objectContaining({ type: 'end', reason: 'refused' }),
    ]);

    const long = await collect(new ScriptedClient([{ events: [text('…')], final: { stop_reason: 'max_tokens' } }]));
    expect(long.at(-1)).toMatchObject({ type: 'end', reason: 'length' });
  });

  it('reports a fallback to another model', async () => {
    const fallback = {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } },
    } as unknown as Step;
    const events = await collect(new ScriptedClient([{ events: [fallback], final: { stop_reason: 'end_turn' } }]));
    expect(events[0]).toEqual({ type: 'fallback', from: 'claude-opus-5-5', to: 'claude-opus-5' });
  });
});
