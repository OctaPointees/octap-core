---
title: Errors
description: The error classes the Node SDK throws, and what each status code means.
---

Every error the SDK throws extends `OctaSdkError`.

```ts
import { OctaApiError, OctaNetworkError, OctaRequestAbortedError } from '@octap/sdk';
```

| Class | Thrown when | Did it reach OctaP? |
| --- | --- | --- |
| `OctaApiError` | OctaP answered with an error status | Yes |
| `OctaNetworkError` | The request or response failed in transit. `cause` holds the original error. | Maybe |
| `OctaRequestAbortedError` | Your `AbortSignal` fired | Maybe |
| `OctaSdkError` | No `fetch` is available, or a webhook signature is invalid | No |

## OctaApiError

| Property | Type | Description |
| --- | --- | --- |
| `statusCode` | `number` | HTTP status |
| `statusText` | `string` | |
| `responseBody` | `unknown` | The parsed body. Don't log it raw. |
| `message` | `string` | From the body when it has one |
| `retryAfter` | `string \| undefined` | The `Retry-After` header, in seconds |

## Status codes

| Status | Meaning | What to do |
| --- | --- | --- |
| 400 | The request is invalid, or a rule refused it | Fix the request. On finalize, read the state first, because the transaction may have been sent. |
| 401 | The API key or customer token is missing, invalid or expired | Check the key, or ask the customer to sign in again |
| 403 | The key lacks a scope, or the organization or member isn't active | Check the [scopes](/concepts/api-keys-and-scopes/#scopes) and the member's status |
| 404 | Not found in your organization | Check the ID |
| 409 | The key was used for another request, or the state doesn't allow this | Read the state. Don't switch keys to get past it. |
| 422 | Your organization's program isn't provisioned | Finish provisioning |
| 429 | Rate limited | Wait `retryAfter` seconds |
| 5xx | Server error, and the outcome is unknown | [Read the state first](/concepts/idempotency-and-recovery/#recover-from-an-unknown-outcome) |
| 503 | OctaP can't check the rate limit, so it refused the request | Retry later |

Never log raw bodies, tokens, signatures or API keys.
