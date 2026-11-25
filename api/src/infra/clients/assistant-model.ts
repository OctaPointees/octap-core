/**
 * What the dashboard assistant (OCT-308) needs from a model provider, whichever it is. Each provider
 * client calls its own API with its hosted MCP tool, so the provider itself calls the OctaP MCP
 * server with `mcp.token`, and maps what it streams back to these events. Vendor details stay in the
 * provider's own client.
 */

import type { AssistantStopReason } from '@octap/contracts';

export interface AssistantRunRequest {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; text: string }>;
  /** The OctaP MCP server and the short-lived token the model reads it with. Never logged or returned. */
  mcp: { url: string; token: string };
  /** Tool calls allowed in this turn; one more ends the turn. */
  maxToolCalls: number;
  signal: AbortSignal;
}

/** What the run produced, in order. */
export type AssistantRunEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string }
  | { type: 'tool_result'; toolUseId: string; isError: boolean }
  | { type: 'refusal'; category: string | null }
  | { type: 'end'; reason: AssistantStopReason; usage: AssistantUsage };

export interface AssistantUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  modelCalls: number;
  /**
   * Set when a model call was cut off (the tool-call cap) before the provider reported its final
   * usage: the counts hold only what the stream had reported, so they under-count that call.
   */
  partial?: true;
}

export interface AssistantModelClient {
  run(request: AssistantRunRequest): AsyncGenerator<AssistantRunEvent>;
}
