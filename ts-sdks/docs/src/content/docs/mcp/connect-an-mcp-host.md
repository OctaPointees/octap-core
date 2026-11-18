---
title: Connect an MCP host
description: Let an AI assistant such as Claude Desktop or Cursor read OctaP member balances, transactions and vouchers with @octap/mcp.
---

`@octap/mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server. It lets an AI assistant (the *MCP host*, such as Claude Desktop, Cursor or Antigravity) answer questions like "what is this member's balance?" by calling the OctaP Core API for you.

This page describes `@octap/mcp` **0.1.0**, built from the `octap-core` repository (`ts-sdks/packages/mcp`).

:::caution[Pilot, read-only]
The server is a developer and staging pilot. It is not yet approved for production customer data. It only reads: it cannot earn, redeem, reverse or grant anything, and it never holds Sui keys or touches the database.
:::

## How it works

The host starts `octap-mcp` on your computer and talks to it over stdio. Each tool call becomes one authenticated REST call through [`@octap/sdk`](/reference/node/client/), using your organization's API key. OctaP Core enforces the key's organization and scope, exactly as it does for the SDK.

```text
AI assistant (MCP host) --stdio--> octap-mcp --HTTPS + API key--> OctaP Core API
```

## Before you start

- Node 20.3 or later on the computer that runs the host.
- An OctaP API key with the `read` scope. See [API keys and scopes](/concepts/api-keys-and-scopes/).
- The Core API URL, for example `http://127.0.0.1:3000` for a [local server](/get-started/run-locally/).

:::danger[The key reads every member of your organization]
The key is organization-scoped, so the assistant can look up **any** member of your organization by ID. Give `octap-mcp` to merchant staff such as owners, business developers and support, not to customers. Never put it behind a customer-facing chat with a shared organization key.
:::

## 1. Save your API URL and key

The host and the server talk over stdout, so the server can't ask you for anything. Run setup once in a normal terminal:

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

## 2. Add the server to your host

Add this to your host's MCP config, for example `claude_desktop_config.json`. No env vars are needed after setup.

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

Restart the host. On startup the server writes one line to the host's log (stderr) with the URL it uses and where the URL and key came from.

:::caution
Don't launch it with `npm run` or `npm start`. npm prints a banner on stdout, which breaks the protocol and disconnects the host.
:::

## 3. Make a first call

Ask the assistant something like:

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

To try the tools without an assistant, open them in the MCP Inspector:

```sh
npx @modelcontextprotocol/inspector npx -y @octap/mcp
```

## Tools

All three tools are read-only and only see the organization that owns the key. `memberId` is the member's OctaP UUID, the `organizationEndUserId` the Node SDK returns.

### `get_member_balance`

| Input | Type | |
| --- | --- | --- |
| `memberId` | UUID | Required |

Returns `confirmedBalance` (spendable now), `pendingEarn` (earns not yet confirmed), `pendingRedemption` (points on hold), `lifetimeEarned`, `lifetimeRedeemed`, and `asOfCheckpoint`, `observedAt` and `stale`, which say how fresh the chain reading is. Same data as [`getBalance`](/reference/node/credits/).

### `list_member_transactions`

| Input | Type | |
| --- | --- | --- |
| `memberId` | UUID | Required |
| `limit` | 1–50 | Default 20 |

Returns the newest transactions first. Each one has `transactionId`, `type`, `status`, `pointsAmount` (`null` until a pending transaction settles), `estimatedPoints`, `purchaseAmount`, `blockchainDigest`, `createdAt` and `updatedAt`. See [status values](/reference/status-values/).

### `list_member_vouchers`

| Input | Type | |
| --- | --- | --- |
| `memberId` | UUID | Required |
| `limit` | 1–50 | Default 20 |

Returns the member's vouchers, each with `ownershipId`, `voucherId`, `title`, `status`, `claimedAt`, `redeemedAt` and `expiresAt`. Serial codes are never returned.

## Troubleshooting

| What you see | Why | Fix |
| --- | --- | --- |
| The host shows the server as failed. Its log says `OCTAP_API_KEY is required` or `OCTAP_API_URL is required`. | No saved file and no env vars. | Run `npx -y @octap/mcp setup`. |
| `OCTAP_API_URL must use HTTP or HTTPS` | The URL is not an absolute `http://` or `https://` URL. | Run setup again with the full URL. |
| `Core denied this read. Check that the configured credential is valid and has the read scope.` | The key is wrong, revoked, or lacks `read` (401 or 403). | Save a valid `read` key with setup. |
| `No matching member or resource was found in the configured organization.` | The member doesn't exist, **or belongs to another organization**. Core answers both with the same 404 so it can't be used to find other merchants' members. | Check the member ID and that you use that organization's key. |
| `Rate limited; do not retry this call in this turn.` | Your key went over its rate limit (429). | Wait a minute and ask again. |
| `Core is temporarily unavailable…` or `Core could not complete this read…` | Core returned a 5xx, couldn't be reached, or took over 12 seconds. | Check the API URL and that Core is running. Details are in the host's server log. |
| The host disconnects right after starting the server. | Something printed to stdout, usually `npm run`. | Use the `npx` config above. |

To take access away from a computer, run `octap-mcp setup --clear`. That only deletes the local copy of the key. If the key may have leaked, also revoke it in the OctaP Console.

## Not available yet

These are planned and not part of 0.1.0:

- Tools that change data, such as earning points or granting vouchers.
- Signing in to a remote MCP server as a Console user instead of saving an organization key.
- A one-click desktop bundle.

To build OctaP features into your own product instead, use the [Node SDK](/get-started/backend-quickstart/) and [Browser SDK](/get-started/frontend-quickstart/).
