# assistant

The dashboard assistant (OCT-308). A signed-in console user asks a question about their
organization and gets a streamed answer from a model (Claude by default, or OpenAI), which reads the
organization through the OctaP MCP server with exactly the permissions an MCP host would have.

## Flow

`POST /v1/console/organizations/:organizationId/assistant/messages` (Google console sign-in only;
an MCP token is refused) with `{ message, history? }`:

1. `AssistantService.prepare` checks the settings (503 until the chosen provider's settings and
   `OCTAP_MCP_PUBLIC_URL` are set), the body limits (400), the membership (403) and the per-user rate
   limit (429, `ASSISTANT_RATE_LIMIT_PER_MINUTE`, default 10). These fail as plain JSON errors.
2. It issues a 10-minute MCP access token for this user, organization and persona
   (`McpOAuthService.issueAssistantToken`, client id `octap-dashboard-assistant`), bound to
   `<OCTAP_MCP_PUBLIC_URL>/mcp`. It is an ordinary MCP token: the MCP server introspects it and gets
   the persona's tool set (OCT-294), and Core rechecks the membership on every tool call, so a
   suspended user is cut off mid-conversation.
3. The provider's client calls its API with a hosted MCP tool, so the provider's servers call the
   MCP server directly with the token. `ASSISTANT_PROVIDER` picks it:
   - `anthropic` (default, `ANTHROPIC_API_KEY`): `AnthropicAssistantClient` (`infra/clients/anthropic`),
     the Messages API with the MCP connector (`mcp-client-2025-11-20`). Claude Opus 5.5, adaptive
     thinking, effort `medium`, server-side fallback on refusals, `pause_turn` resumed up to 3 times.
   - `openai` (`OPENAI_API_KEY`, `OPENAI_MODEL`): `OpenAiAssistantClient` (`infra/clients/openai`), the
     Responses API with its `mcp` tool, `require_approval: never` and `store: false`. The model is a
     setting: pick one that supports the MCP tool.

   Both stop at 12 tool calls per turn and map their stream to the same events
   (`infra/clients/assistant-model.ts`).
4. The answer streams back as server-sent events (`AssistantStreamEvent` in `@octap/contracts`):
   `text`, `tool`, `tool_error`, `refusal`, then `done` or `error`. The token is revoked when the turn
   ends, however it ends.

The persona and organization in the system prompt come from the verified sign-in, never from the
browser. Nothing is stored: the browser sends the history (at most 40 turns and 60000 characters).
Logs carry the request id, organization, persona, tool names, token usage and outcome; never message
text, tool results, the Anthropic key or the MCP token.

## Privacy and cost

Member data the tools return (names, emails, phone numbers, balances) is sent to the chosen provider
(Anthropic or OpenAI) as model input. Each turn costs tokens; the rate limit, the tool-call cap and `max_tokens` keep one user from
running up the bill.

## Local development

The MCP server must be reachable from the internet, because the provider's servers call it: run
`octap-mcp serve-http` behind a temporary tunnel and set `OCTAP_MCP_PUBLIC_URL` to the tunnel's
origin, or point it at the deployed server (OCT-307).

## Not here yet

Write actions (they will stream a confirmation event first), saved conversations, the chat panel
(OCT-309), and audit-trail entries for tool calls (OCT-296).
