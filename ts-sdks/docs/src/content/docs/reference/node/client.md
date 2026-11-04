---
title: Client
description: Create and configure the Node SDK client.
---

```ts
import { createOctaPointClient } from '@octap/sdk';

const client = createOctaPointClient({
  baseUrl: process.env.OCTAP_API_URL,
  credentials: { apiKey: process.env.OCTAP_API_KEY },
});
```

`new OctaPointClient(options)` does the same thing.

## Options

| Option | Type | Description |
| --- | --- | --- |
| `baseUrl` | `string` | Core API URL. Defaults to `http://localhost:3000`, so set it outside local development. |
| `credentials.apiKey` | `string` | Your API key. Sent as `Authorization: Bearer`. |
| `organizationId` | `string` | Sent as `x-organization-id`. Must match the key's organization. |
| `fetchFn` | `typeof fetch` | Replaces the global `fetch`. |
| `transport` | `RestTransport` | Alternative way to supply `baseUrl` and `fetchFn`. |

Creating a client throws `OctaSdkError` if the runtime has no `fetch` and you didn't supply one.

## Request options

Every method takes `RequestOptions` as its last argument.

| Option | Type | Description |
| --- | --- | --- |
| `organizationId` | `string` | Overrides the client's value for this call. |
| `signal` | `AbortSignal` | Cancels local waiting. It doesn't undo anything on OctaP or the chain. |

## Methods

| Area | Methods |
| --- | --- |
| [Identity and credits](/reference/node/credits/) | `verifyCustomer`, `earnPoints`, `getBalance`, `listTransactions`, `reservePosRedemption`, `finalizePosRedemption`, `reverseTransaction` |
| [Vouchers](/reference/node/vouchers/) | `createVoucher`, `updateVoucher`, `listVouchers`, `getVoucher`, `claimVoucher`, `getVoucherClaim`, `finalizeVoucherClaim`, `redeemVoucher`, `listMemberVouchers`, `getVoucherRefundPolicy`, `setVoucherRefundPolicy`, `listVoucherRefundPolicyHistory` |
| [Webhooks](/reference/node/webhooks/) | `registerWebhookEndpoint`, `listWebhookEndpoints`, `disableWebhookEndpoint`, `enableWebhookEndpoint`, `rotateWebhookSecret`, `listWebhookDeliveries`, `replayWebhookDelivery`, `verifyWebhookSignature`, `constructWebhookEvent` |

## Out of scope

Console and platform routes use portal sessions, not API keys, so this client doesn't wrap them. API key management is also outside it.

## Types

`@octap/sdk` re-exports the request, response and webhook types from `@octap/contracts`, so you can import them from one place:

```ts
import type { EarnPointsRequest, VoucherDto, WebhookEvent } from '@octap/sdk';
```
