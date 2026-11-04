---
title: Installation
description: The OctaP SDK packages, what each one is for, and how to use them today.
---

## Packages

| Package | Runs on | Use it for |
| --- | --- | --- |
| `@octap/sdk` | Your Node server | Points, vouchers, webhooks and verifying customers. Holds your API key. |
| `@octap/browser-sdk` | Your website | Customer sign-in and signing. Holds no merchant credential. |
| `@octap/contracts` | Anywhere | TypeScript types only. `@octap/sdk` re-exports the ones you need. |

Never import `@octap/sdk` into browser code, because it would expose your API key.

## Install

:::caution[Not on npm yet]
The packages are private and unpublished, so the command below does not work yet. `@octap/browser-sdk` is at version 0.1.0 and `@octap/sdk` at 0.0.0, and both may still change.
:::

Once they are published, you will install them like this:

```sh
# On your server
npm install @octap/sdk

# On your website
npm install @octap/browser-sdk
```

## Use them today

Work inside the `octap-core` repository, where the root manages every package as an npm workspace.

```sh
git clone https://github.com/OctaPointees/octap-core.git
cd octap-core
npm ci
npm run build
```

Code in that repository can then import `@octap/sdk` and `@octap/browser-sdk` by name. [Run it locally](/get-started/run-locally/) shows the examples that do this.

## Requirements

- **Node SDK:** a runtime with a global `fetch`. The repository itself requires Node `>=24.15 <25`.
- **Browser SDK:** a modern browser that can load Google's sign-in script.
- **From OctaP:** an API key, your organization ID, and for sign-in, the shared Google client ID with your site's origin added to it.
