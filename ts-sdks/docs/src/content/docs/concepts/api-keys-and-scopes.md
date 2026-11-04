---
title: API keys and scopes
description: How the Node SDK authenticates, which scope each route needs, and the rate limits.
---

The Node SDK sends your key as `Authorization: Bearer <api key>`. Each key belongs to one organization, so you don't normally need to pass an organization ID. If you do pass one, it must match the key's organization, or the request gets a 403.

Keep keys on a trusted server. API key management is not part of this SDK.

## Scopes

A key can hold the `read`, `write` and `admin` scopes. A key missing the required scope gets a 403.

| Scope | SDK methods |
| --- | --- |
| `read` | `verifyCustomer`, `getBalance`, `listTransactions`, `getVoucherRefundPolicy`, `listVouchers`, `getVoucher`, `getVoucherClaim`, `listMemberVouchers`, `listWebhookEndpoints`, `listWebhookDeliveries` |
| `write` | `earnPoints`, `reservePosRedemption`, `reverseTransaction`, `createVoucher`, `updateVoucher`, `claimVoucher`, `redeemVoucher` |
| `admin` | `setVoucherRefundPolicy`, `listVoucherRefundPolicyHistory`, `registerWebhookEndpoint`, `disableWebhookEndpoint`, `enableWebhookEndpoint`, `rotateWebhookSecret`, `replayWebhookDelivery` |
| None | `finalizePosRedemption`, `finalizeVoucherClaim`: the customer's signature authorizes these |

Some refunds also need `admin`: a reversal that the refund policy allows only for an expired or already redeemed voucher.

Give each service the smallest set of scopes it needs.

## Rate limits

Limits use a fixed 60-second window. Over the limit, you get a 429 with a `Retry-After` header, which the SDK exposes as `error.retryAfter`.

| Routes | Limited by | Default per minute |
| --- | --- | --- |
| Routes that use an API key | Each key | 120 |
| Public routes, including finalize and customer sign-in | Each client IP | 60 |

If OctaP can't check the limit, the request gets a 503 rather than going through.
