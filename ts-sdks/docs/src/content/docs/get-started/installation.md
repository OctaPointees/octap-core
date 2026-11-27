---
title: Installation
description: The OctaP SDK packages, what each one is for, and how to install them from npm.
---

## Packages

| Package | Runs on | Use it for |
| --- | --- | --- |
| `@octap/sdk` | Your Node server | Points, vouchers, webhooks and verifying customers. Holds your API key. |
| `@octap/browser-sdk` | Your website | Customer sign-in and signing. Holds no merchant credential. |
| `@octap/contracts` | Anywhere | TypeScript types only. `@octap/sdk` re-exports the ones you need. |
| `@octap/mcp` | A teammate's computer | Read-only MCP server that lets an AI assistant look up members. See [Connect an MCP host](/mcp/connect-an-mcp-host/). |
| `@octap/verify` | An auditor's computer | Checks an audit evidence bundle against its seal on Sui, without trusting OctaP: `npx @octap/verify bundle.json`. |

Never import `@octap/sdk` into browser code, because it would expose your API key.

## Install

All packages are public on npm under the `@octap` scope. They are pre-1.0, so a minor version may still contain breaking changes.

```sh
# On your server
npm install @octap/sdk

# On your website
npm install @octap/browser-sdk
```

`@octap/sdk` installs `@octap/contracts` for you. The packages are ES modules only.

## Work from the repository

To change the SDKs, or to run the examples against your own changes, use the `octap-core` repository. Its root manages every package as an npm workspace:

```sh
git clone https://github.com/OctaPointees/octap-core.git
cd octap-core
npm ci
npm run build
```

[Run it locally](/get-started/run-locally/) shows the examples that do this.

## Requirements

- **Node SDK:** a runtime with a global `fetch`. The repository itself requires Node `>=24.15 <25`.
- **Browser SDK:** a modern browser that can load Google's sign-in script.
- **From OctaP:** an API key, your organization ID, and for sign-in, the shared Google client ID with your site's origin added to it.
