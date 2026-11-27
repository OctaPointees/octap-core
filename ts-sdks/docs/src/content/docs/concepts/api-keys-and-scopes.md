---
title: API keys and scopes
description: How the Node SDK authenticates, which scope each route needs, and the rate limits.
---

The Node SDK sends your key as `Authorization: Bearer <api key>`. Each key belongs to one organization, so you don't normally need to pass an organization ID. If you do pass one, it must match the key's organization, or the request gets a 403.

Keep keys on a trusted server. API key management is not part of this SDK.

## Scopes

A key holds the `read` scope, or `read` and `write`. A key missing the required scope gets a 403. Every key the console creates works with every SDK method below that its scopes allow.

A key's scopes are what it can do, whoever holds it: a route never checks the role of the person who created the key. In the console, only the organization's Owner creates `write` keys; a Business Developer creates `read` keys.

| Scope | SDK methods |
| --- | --- |
| `read` | `verifyCustomer`, `getBalance`, `listTransactions`, `getIssuanceBudget`, `getVoucherRefundPolicy`, `listVoucherRefundPolicyHistory`, `listVouchers`, `getVoucher`, `getVoucherClaim`, `listMemberVouchers`, `listWebhookEndpoints`, `listWebhookDeliveries` |
| `write` | `earnPoints`, `reservePosRedemption`, `reverseTransaction`, `createVoucher`, `updateVoucher`, `claimVoucher`, `grantVoucher`, `prepareVoucherUse` |
| None | `finalizePosRedemption`, `finalizeVoucherClaim`, `finalizeVoucherUse`: the customer's signature authorizes these |

`reverseTransaction` refunds whatever the organization's refund policy allows, including an expired or already redeemed voucher when the policy says so. The policy is the only gate, and only the Owner sets it.

## What no key can do

Managing webhook endpoints and the refund policy is the organization's Owner's, in the console: registering, disabling, enabling and rotating webhook endpoints, and publishing a refund policy. A Business Developer can see the endpoints and deliveries there, send a test event and replay a delivery. A key reads them (`listWebhookEndpoints`, `listWebhookDeliveries`, `getVoucherRefundPolicy`, `listVoucherRefundPolicyHistory`) but never changes them. See [Receive webhooks](/guides/receive-webhooks/) and [Manage vouchers](/guides/manage-vouchers/).

Keys made before OctaP retired the `admin` scope may still list it. OctaP ignores it: such a key can do what its `read` and `write` scopes allow, and nothing more.

Give each service the smallest set of scopes it needs.

## Rate limits

Limits use a fixed 60-second window. Over the limit, you get a 429 with a `Retry-After` header, which the SDK exposes as `error.retryAfter`.

| Routes | Limited by | Default per minute |
| --- | --- | --- |
| Routes that use an API key | Each key | 120 |
| Public routes, including finalize and customer sign-in | Each client IP | 60 |

If OctaP can't check the limit, the request gets a 503 rather than going through.
