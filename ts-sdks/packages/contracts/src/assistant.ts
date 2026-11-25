/**
 * The dashboard assistant (OCT-308): a chat in the console backed by an OpenAI model, which
 * reads the organization through the OctaP MCP server with the signed-in user's persona.
 */

/** One earlier turn of the conversation. The browser keeps the history; Core stores none. */
export interface AssistantTurn {
  role: 'user' | 'assistant';
  /** Plain text of that turn. */
  text: string;
}

/** `POST /v1/console/organizations/:organizationId/assistant/messages` */
export interface AssistantMessageBody {
  /** The new question. 1–4000 characters. */
  message: string;
  /**
   * The conversation so far, oldest first, starting with a user turn. At most 40 turns and 60000
   * characters together with the new message.
   */
  history?: AssistantTurn[];
}

/**
 * One event of the answer stream (`text/event-stream`; each `data:` line is one JSON event, and the
 * SSE `event:` name equals `type`). The stream always ends with `done` or `error`.
 */
export type AssistantStreamEvent =
  /** The next piece of the answer. */
  | { type: 'text'; text: string }
  /** The assistant started reading data with this tool, e.g. `find_member`. */
  | { type: 'tool'; name: string }
  /** That tool failed or was refused, e.g. because the user's access changed. */
  | { type: 'tool_error'; name: string }
  /** The model declined to answer. `category` is the provider's refusal category, when there is one. */
  | { type: 'refusal'; category: string | null }
  /** The turn ended. `reason` says why the answer may be incomplete. */
  | { type: 'done'; reason: AssistantStopReason }
  /** The turn failed after the stream started. The message is safe to show. */
  | { type: 'error'; message: string };

/**
 * - `complete`: the answer is finished.
 * - `tool_limit`: the assistant needed more tool calls than one turn allows; ask a narrower question.
 * - `length`: the answer hit the length limit.
 * - `refused`: see the `refusal` event.
 */
export type AssistantStopReason = 'complete' | 'tool_limit' | 'length' | 'refused';
