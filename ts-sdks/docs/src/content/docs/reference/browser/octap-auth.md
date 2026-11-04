---
title: OctapAuth
description: The Browser SDK's sign-in, session and signing API.
---

## createOctapAuth

```ts
import { createOctapAuth } from '@octap/browser-sdk';

const auth = createOctapAuth(options);
```

`new OctapAuth(options)` does the same thing.

| Option | Type | Description |
| --- | --- | --- |
| `apiBaseUrl` | `string` | **Required.** Core API URL. |
| `organizationId` | `string` | **Required.** Customers enroll in this organization. |
| `googleClientId` | `string` | **Required.** The client ID OctaP gives you. |
| `persistence` | `'session' \| 'memory'` | Where the session is kept. Defaults to `'session'`. |
| `timeoutMs` | `number` | Request timeout. Defaults to 35 seconds. Finalize waits 90 seconds. |
| `fetch` | `typeof fetch` | Replaces the global `fetch`. |

A stored session is tied to these three required values, so changing any of them doesn't restore it.

## currentUser

The signed-in customer, available straight after a reload. `null` once the session expires.

```ts
auth.currentUser: OctapUser | null
```

| Field | Type | Description |
| --- | --- | --- |
| `endUserId` | `string` | |
| `memberId` | `string` | Their `organizationEndUserId` in your organization |
| `suiAddress` | `string` | |

## onAuthStateChanged

Calls the listener with the current customer soon after subscribing, then on every change. Returns a function that unsubscribes.

```ts
auth.onAuthStateChanged(listener: (user: OctapUser | null) => void): () => void
```

## renderGoogleButton

Renders Google's button, and handles the key, nonce, enrollment and proof when the customer uses it. It renders nothing while a customer is signed in.

```ts
auth.renderGoogleButton(element: HTMLElement, options?: RenderOptions): Promise<void>
```

| Option | Type | Description |
| --- | --- | --- |
| `onError` | `(error: OctapAuthError) => void` | Sign-in failures, which happen outside any call you could await |
| `button` | `object` | Passed to Google's button, such as `theme`, `size`, `text` or `shape` |

## getIdToken

Returns the id_token for your backend to [verify](/guides/verify-a-customer/). If it has expired, the customer is signed out, and this throws `token-expired`.

```ts
auth.getIdToken(): Promise<string>
```

## signAndFinalize

Signs a `RESERVED` claim and finalizes it. The voucher isn't owned until this resolves. Never retries.

```ts
auth.signAndFinalize(claim: SignableClaim, options?: RequestOptions): Promise<FinalizedClaim>
```

`claim` needs `status`, `digest` and `transactionBytes`, which `claimVoucher` on your backend returns. `options` takes `signal` and `timeoutMs`.

Every failure except a rate limit becomes `outcome-unknown`, because a failed response doesn't prove the transaction didn't land. A rate limit is the one failure that proves nothing was attempted, so it comes through as `api-error` with status 429.

## signTransaction

Returns the zkLogin signature over base64 transaction bytes, and sends nothing. Refuses bytes whose sender isn't the signed-in customer.

```ts
auth.signTransaction(transactionBytes: string): Promise<string>
```

## signOut

Ends the session and abandons any sign-in still running. The button returns.

```ts
auth.signOut(): Promise<void>
```

## Session security

The session holds the ephemeral signing key, the proof and the id_token until its `maxEpoch` or sign-out.

| `persistence` | Survives a reload | Risk |
| --- | --- | --- |
| `'session'` | Yes, in this tab | Any script on your page can read `sessionStorage` |
| `'memory'` | No, a reload signs the customer out | Lower exposure, with the key kept only in memory |

An XSS flaw on a page using `'session'` lets an attacker sign as this customer until the session expires. Use a strict Content Security Policy, and avoid third-party scripts on these pages. The private key is never sent anywhere: only its public half reaches OctaP.
