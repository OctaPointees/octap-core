---
title: Connect an MCP host
description: Let an AI assistant read OctaP members, vouchers, budgets and operations with @octap/mcp over stdio or remote HTTP.
---

`@octap/mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server. It lets an AI assistant (the *MCP host*, such as Claude Desktop, Cursor or Antigravity) answer questions like "what is this member's balance?" or "which vouchers are waiting for approval?" by calling the OctaP Core API for you.

This page describes `@octap/mcp` built from the `octap-core` repository (`ts-sdks/packages/mcp`).

:::caution[Read-only server]
Every tool in `@octap/mcp` is strictly read-only: it cannot earn, redeem, reverse, approve or grant anything, and it never holds Sui keys or touches the database.
:::

## Choose how to connect

| Mode | Auth | Tools | Best for |
| --- | --- | --- | --- |
| **Local stdio** (`octap-mcp`) | Organization API key (`read` scope) | 3 member tools | Local developer or support workflows with an API key |
| **Remote HTTP** (`octap-mcp serve-http`) | Console Google OAuth (1-hour token) | 13 (Developer) or 19 (Owner) console tools + prompts | Staff members signing in with their own Console role |
| **Embedded** (`createServer()`) | Host's validated `http.authInfo` + `resolveMemberId` | Narrowed subset (e.g. balance & transactions) | Customer-facing chat widgets in your own backend |

---

## Option A: Local stdio with an API key

The host starts `octap-mcp` on your computer and talks to it over stdio. Each tool call becomes one authenticated REST call through [`@octap/sdk`](/reference/node/client/), using your organization's API key.

```text
AI assistant (MCP host) --stdio--> octap-mcp --HTTPS + API key--> OctaP Core API
```

### Before you start

- Node 20.3 or later on the computer that runs the host.
- An OctaP API key with the `read` scope. See [API keys and scopes](/concepts/api-keys-and-scopes/).
- The Core API URL, for example `http://127.0.0.1:3000` for a [local server](/get-started/run-locally/).

:::danger[The key reads every member of your organization]
An API key is organization-scoped, so the assistant can look up **any** member of your organization by ID. Give stdio `octap-mcp` to merchant staff such as owners, business developers and support, not to customers. Never put it behind a customer-facing chat with a shared organization key.
:::

### 1. Save your API URL and key

The host and the server talk over stdout, so the server can't ask you for anything itself. Run setup once in a normal terminal:

```sh
npx -y @octap/mcp setup
```

```text
Octap API URL [http://127.0.0.1:3000]: https://api.example.com
Octap API key (input hidden): ********

Saved API URL https://api.example.com/ and key ****1a2b to:
  /Users/you/.octap/mcp.json
```

The URL and key are saved to `~/.octap/mcp.json`, or `%USERPROFILE%\.octap\mcp.json` on Windows. On macOS and Linux only your user can read the file. Run setup again to change either value; press Enter to keep the saved key.

| Command | What it does |
| --- | --- |
| `octap-mcp setup` | Ask for the URL and key, then save them |
| `octap-mcp setup --path` | Print where the file is |
| `octap-mcp setup --clear` | Delete the file. The server then refuses to start. |

`OCTAP_API_URL` and `OCTAP_API_KEY` environment variables override the file, one setting at a time. `OCTAP_MCP_CONFIG_PATH` moves the file.

### 2. Add the server to your host

Add this to your host's MCP config, for example `claude_desktop_config.json`. No env vars are needed after setup:

```json
{
  "mcpServers": {
    "octap": {
      "command": "npx",
      "args": ["-y", "@octap/mcp"]
    }
  }
}
```

From a local checkout, build first (`npm install && npm run build` at the repository root) and use `"command": "node"`, `"args": ["<path-to-octap-core>/ts-sdks/packages/mcp/dist/cli.js"]`.

Restart the host. On startup the server writes one line to the host's log (`stderr`) with the URL it uses and where the URL and key came from.

:::caution
Don't launch it with `npm run` or `npm start`. npm prints a banner on stdout, which breaks the protocol and disconnects the host.
:::

---

## Option B: Remote HTTP with Console Google sign-in (`serve-http`)

Instead of sharing an API key, staff can sign in with the Google account they use on the OctaP Console. Core acts as the OAuth 2.1 authorization server (`POST /oauth/register`, `GET /oauth/authorize` with PKCE S256, `POST /oauth/token`, `POST /oauth/revoke`).

Each sign-in produces a 1-hour opaque token (`octap_mcp_…`) bound to **one organization** and the user's **persona** there (`BUSINESS_OWNER` or `BUSINESS_DEVELOPER`). Core re-checks the user's membership on every call and refuses the token immediately if their access is suspended or their role changes.

```text
MCP host --Streamable HTTP + Bearer token--> octap-mcp serve-http --GET + token--> OctaP Core API
```

### Core & Google OAuth prerequisites

- Core must have `MCP_OAUTH_ISSUER_URL` (Core's public origin, no path) and `MCP_OAUTH_SIGNING_KEY` (32-byte base64 secret) set; otherwise Core answers `503` on the OAuth routes.
- Core's origin must be listed in the authorized JavaScript origins of `CONSOLE_GOOGLE_CLIENT_ID`, because `/oauth/authorize` runs Google Identity Services on Core's origin.
- Redis must be running on Core (pending OAuth requests, 60-second auth codes, and 1-hour tokens are stored in Redis under SHA-256 keys).

### Start the HTTP server

```sh
OCTAP_API_URL=https://api.octap.example \
OCTAP_MCP_PUBLIC_URL=https://mcp.octap.example \
OCTAP_MCP_PORT=4100 \
npx -y @octap/mcp serve-http
```

Point your MCP host or inspector at `<OCTAP_MCP_PUBLIC_URL>/mcp` as a Streamable HTTP server. The server publishes RFC 9728 protected-resource metadata, responds `401` to unauthenticated requests, and the host opens Core's Google sign-in page in a browser.

For local testing: run Core on `http://localhost:3000` with `MCP_OAUTH_ISSUER_URL=http://localhost:3000`, start `OCTAP_API_URL=http://localhost:3000 npx -y @octap/mcp serve-http`, and connect MCP Inspector to `http://localhost:4100/mcp`.

---

## Option C: Embed in a customer-facing backend (`createServer()`)

To embed MCP inside a customer-facing chat widget or backend:

1. Pass `resolveMemberId(context)` to `createServer()` to map your verified `http.authInfo` to the customer's member UUID. When `resolveMemberId` is set, `memberId` is removed from the tool parameters exposed to the LLM.
2. Restrict `tools` to customer-safe reads (for example `['get_member_balance', 'list_member_transactions']`).
3. Optionally pass `project` to redact or reshape fields before they reach the model.

Never treat the MCP session ID or model-supplied IDs as authentication. See `ts-sdks/packages/mcp/examples/customer-embed.ts` in the repository for a runnable example.

---

## Make a first call

Ask your assistant (or run `npx @modelcontextprotocol/inspector npx -y @octap/mcp` locally):

> What is the balance of member 3f6c2a9e-8b1d-4c57-9e0a-2d4b6f8c1e73?

The assistant calls `get_member_balance` and gets back:

```json
{
  "memberId": "3f6c2a9e-8b1d-4c57-9e0a-2d4b6f8c1e73",
  "confirmedBalance": 120,
  "pendingEarn": 0,
  "pendingRedemption": 0,
  "lifetimeEarned": 120,
  "lifetimeRedeemed": 0,
  "asOfCheckpoint": "48211907",
  "observedAt": "2026-11-18T03:12:45.000Z",
  "stale": false
}
```

See [MCP tools and prompts](/mcp/tools-and-prompts/) for the full list of stdio and persona-based tools.

---

## Security & redaction

Every tool returns whitelisted fields only. Voucher `serialCode` values, API key secrets/hashes, webhook signing secrets, webhook URL query strings, invitation tokens, and tax/identity numbers never reach the model.

Over `serve-http`, `src/personas.ts` controls which tools and prompts each persona sees, while Core enforces the organization, read-only `GET` restriction, and persona on every HTTP call.

---

## Dashboard assistant endpoint on Core

Core also exposes `POST /v1/console/organizations/:organizationId/assistant/messages` (Google console sign-in only; MCP tokens are refused). When configured (`OPENAI_API_KEY`, `OPENAI_MODEL`, `OCTAP_MCP_PUBLIC_URL`, plus MCP sign-in), Core mints a 10-minute MCP token for the user's persona, connects OpenAI's Responses API `mcp` tool to the MCP server, streams SSE events (`text`, `tool`, `tool_error`, `refusal`, `done`/`error`), caps turns at 12 tool calls, and revokes the token when the turn ends.

---

## Troubleshooting

| What you see | Why | Fix |
| --- | --- | --- |
| `OCTAP_API_KEY is required` or `OCTAP_API_URL is required` | No saved file and no env vars (stdio mode). | Run `npx -y @octap/mcp setup`. |
| `OCTAP_API_URL must use HTTP or HTTPS` | The URL is not an absolute `http://` or `https://` URL. | Run setup again with the full URL. |
| `Core denied this read…` (401 or 403) | API key is wrong/revoked/lacks `read`, or OAuth token expired (1h) / membership suspended. | Re-save a valid `read` key, or sign in again over OAuth. |
| `No matching member or resource was found in the configured organization.` | The ID doesn't exist **or belongs to another organization**. Core answers both with 404. | Check the ID and that you are connected to the right organization. |
| `Rate limited; do not retry this call in this turn.` | The credential hit Core's rate limit (429). | Wait a minute and ask again. |
| `Core did not publish OAuth metadata (status 503)` | `MCP_OAUTH_ISSUER_URL` or `MCP_OAUTH_SIGNING_KEY` is not set on Core. | Configure both env vars on Core and restart. |
| `403 {"error":"invalid_host"}` on `serve-http` | Request `Host` header does not match `OCTAP_MCP_PUBLIC_URL`. | Set `OCTAP_MCP_PUBLIC_URL` to the exact public origin callers use. |
| Host disconnects right after starting stdio | Something printed to `stdout` (usually `npm run`). | Launch directly via `npx -y @octap/mcp` or `node .../dist/cli.js`. |

To revoke local stdio access, run `octap-mcp setup --clear` (and revoke the key in the OctaP Console if it may have leaked).

## Not available yet

- Write or mutation tools (earning points, granting/approving vouchers, editing settings).
- OAuth refresh tokens (remote sessions last 1 hour, then re-authenticate).
- Per-user audit trail of MCP tool calls.
- Hosted production remote MCP server (`mcp.octap.com`) and the Console chat UI panel.

To build OctaP features into your own product, use the [Node SDK](/get-started/backend-quickstart/) and [Browser SDK](/get-started/frontend-quickstart/).
