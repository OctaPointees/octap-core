---
title: Idempotency and recovery
description: How to retry safely, and what to do when you don't know whether a request worked.
---

Networks fail after a request has already been processed. Idempotency keys make it safe to send a request again.

## How keys behave

Send a key with every earn, reservation, reversal and paid claim. Keys are unique within your organization. Derive each one from your own record, such as an order ID, and store it before you send the request.

| You send | You get |
| --- | --- |
| A new key | A new operation |
| The same key and the same request | The original result, and no second operation or webhook |
| The same key, simultaneously | One operation. For earns and voucher claims, every caller gets its result. |
| The same key with a changed request | A 409 for earns, reservations and voucher claims, and nothing changes |
| A key used for a different kind of operation | A 409, and nothing changes |

## Recover from an unknown outcome

A timeout, cancellation, network failure or 5xx doesn't tell you what happened. The request may have committed. So:

1. **Keep the key.** Never switch to a new key, because that can create a second earn or spend.
2. **Read the state** with `listTransactions`, `getBalance`, `getVoucherClaim` or your webhook records.
3. **Repeat the request with the same key** if the state doesn't settle it. The same key can only return the original.

The SDK never retries by itself, so this decision stays with you.

## Paid vouchers

A paid claim follows the same rules, with the customer's signature in the middle.

- A `RESERVED` voucher isn't owned yet. Show it as pending.
- If finalize has an unknown outcome, read the claim, or claim again with the **same** key.
- Use a new key only after the claim is `CANCELLED`.

## Operations with no key

| Operation | Before you retry |
| --- | --- |
| `redeemVoucher` | Read the ownership status. A serial can only be redeemed once. |
| `finalizeVoucherClaim`, `finalizePosRedemption` | Reuse the original signature and digest, or read the current state. |
| `registerWebhookEndpoint`, `rotateWebhookSecret` | Don't blindly retry. List your endpoints first. |
| Reads | Retry with bounded backoff, and wait `retryAfter` after a 429. |

## Cancellation

Passing an `AbortSignal` stops your code from waiting. It doesn't undo anything on OctaP or the chain, so treat a cancelled write as an unknown outcome.
