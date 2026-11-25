import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Response,
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';
import { OpenAiAssistantClient, type ResponsesStream } from '#infra/clients/openai/openai-assistant.client.js';
import type { AssistantRunEvent, AssistantRunRequest } from '#infra/clients/assistant-model.js';

type Step = ResponseStreamEvent;
interface Call {
  events: Step[];
  final?: Partial<Response>;
}

const text = (delta: string) => ({ type: 'response.output_text.delta', delta }) as Step;
const mcpCall = (id: string, name: string) =>
  ({
    type: 'response.output_item.added',
    output_index: 0,
    sequence_number: 0,
    item: { type: 'mcp_call', id, name, server_label: 'octap', arguments: '{}' },
  }) as Step;
const mcpDone = (id: string, failed = false) =>
  ({ type: failed ? 'response.mcp_call.failed' : 'response.mcp_call.completed', item_id: id }) as Step;
const usage = { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 100 } };

/** The client with the SDK replaced by one scripted model call. */
class ScriptedClient extends OpenAiAssistantClient {
  readonly params: ResponseCreateParamsStreaming[] = [];
  aborted = 0;
  constructor(private readonly call: Call) {
    super();
  }
  protected override open(params: ResponseCreateParamsStreaming): ResponsesStream {
    this.params.push(params);
    const call = this.call;
    return {
      async *[Symbol.asyncIterator]() {
        yield* call.events;
      },
      finalResponse: async () => ({ status: 'completed', usage, ...call.final }) as Response,
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

async function collect(client: OpenAiAssistantClient, req = request()) {
  const events: AssistantRunEvent[] = [];
  for await (const event of client.run(req)) events.push(event);
  return events;
}

describe('OpenAiAssistantClient (OCT-308)', () => {
  beforeEach(() => vi.stubEnv('OPENAI_MODEL', 'gpt-test'));
  afterEach(() => vi.unstubAllEnvs());

  it('asks the configured model to read the OctaP MCP server with the turn token, and streams the answer', async () => {
    const client = new ScriptedClient({
      events: [mcpCall('m1', 'find_member'), mcpDone('m1'), text('Lan has '), text('42 points.')],
    });
    const events = await collect(client);

    expect(client.params[0]).toMatchObject({
      model: 'gpt-test',
      instructions: 'system prompt',
      input: [
        { role: 'user', content: 'Who is Lan?' },
        { role: 'assistant', content: 'A member.' },
        { role: 'user', content: 'Her balance?' },
      ],
      tools: [
        {
          type: 'mcp',
          server_label: 'octap',
          server_url: 'https://mcp.octap.test/mcp',
          authorization: 'octap_mcp_secret',
          require_approval: 'never',
        },
      ],
      max_tool_calls: 5,
      store: false,
      stream: true,
    });
    expect(events).toEqual([
      { type: 'tool_call', id: 'm1', name: 'find_member' },
      { type: 'tool_result', toolUseId: 'm1', isError: false },
      { type: 'text', text: 'Lan has ' },
      { type: 'text', text: '42 points.' },
      {
        type: 'end',
        reason: 'complete',
        usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 100, modelCalls: 1 },
      },
    ]);
  });

  it('reports a failed tool call, and stops at the tool-call limit', async () => {
    const failed = await collect(new ScriptedClient({ events: [mcpCall('m1', 'get_member'), mcpDone('m1', true)] }));
    expect(failed[1]).toEqual({ type: 'tool_result', toolUseId: 'm1', isError: true });

    const client = new ScriptedClient({
      events: [mcpCall('m1', 'find_member'), mcpCall('m2', 'get_member'), mcpCall('m3', 'list_vouchers')],
    });
    const limited = await collect(client, request({ maxToolCalls: 2 }));
    expect(limited.map((event) => event.type)).toEqual(['tool_call', 'tool_call', 'end']);
    // OpenAI reports usage only with the finished response, so the cut-off call's usage is marked partial.
    expect(limited.at(-1)).toMatchObject({ reason: 'tool_limit', usage: { partial: true } });
    expect(client.aborted).toBe(1);
  });

  it('reports a refusal, a content filter and a cut-off answer', async () => {
    const refused = await collect(
      new ScriptedClient({ events: [{ type: 'response.refusal.delta', delta: 'No.' } as Step] }),
    );
    expect(refused.map((event) => event.type)).toEqual(['refusal', 'end']);
    expect(refused.at(-1)).toMatchObject({ reason: 'refused' });

    const filtered = await collect(
      new ScriptedClient({
        events: [],
        final: { status: 'incomplete', incomplete_details: { reason: 'content_filter' } },
      }),
    );
    expect(filtered[0]).toEqual({ type: 'refusal', category: 'content_filter' });

    const long = await collect(
      new ScriptedClient({
        events: [text('…')],
        final: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
      }),
    );
    expect(long.at(-1)).toMatchObject({ reason: 'length' });
  });

  it('fails the turn when the MCP server refuses the token, or OpenAI reports an error', async () => {
    await expect(
      collect(new ScriptedClient({ events: [{ type: 'response.mcp_list_tools.failed' } as Step] })),
    ).rejects.toThrow('refused to list its tools');
    await expect(
      collect(new ScriptedClient({ events: [{ type: 'error', code: 'rate_limit_exceeded' } as Step] })),
    ).rejects.toThrow('rate_limit_exceeded');
  });

  it('needs OPENAI_MODEL', async () => {
    vi.stubEnv('OPENAI_MODEL', '');
    await expect(collect(new ScriptedClient({ events: [] }))).rejects.toThrow('OPENAI_MODEL');
  });
});
