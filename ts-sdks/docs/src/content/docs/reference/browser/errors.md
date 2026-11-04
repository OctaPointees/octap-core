---
title: Errors
description: The error codes the Browser SDK reports, and what to do about each one.
---

Every failure is an `OctapAuthError` with a `code`. API errors also have `status` and `body`.

```ts
import { OctapAuthError } from '@octap/browser-sdk';

try {
  await auth.signAndFinalize(claim);
} catch (error) {
  if (error instanceof OctapAuthError && error.code === 'outcome-unknown') {
    await refreshClaimFromBackend();
  }
}
```

Failures during sign-in reach you through the `onError` option of `renderGoogleButton`.

| Code | Meaning | What to do |
| --- | --- | --- |
| `sign-in-canceled` | The customer closed Google's window | Nothing. The button still works. |
| `nonce-mismatch` | Google's token wasn't issued for this attempt | Ask them to sign in again |
| `provider-unavailable` | Google's script couldn't load, or the SDK ran outside a browser | Check for blocked scripts |
| `not-signed-in` | No customer is signed in | Show the button |
| `session-expired` | The signing session passed `maxEpoch` | Ask them to sign in again |
| `token-expired` | Google's token expired, after about an hour | Ask them to sign in again |
| `wrong-account` | The transaction belongs to a different customer | Ask them to use that account |
| `invalid-claim` | The claim has nothing to sign, or its bytes are invalid | Check the claim's status |
| `outcome-unknown` | Finalize may have reached the chain | Read the claim. Don't re-create it. |
| `api-error` | OctaP answered with an error | See `status` and `message` |
| `network-error` | OctaP couldn't be reached | Retry later |
| `timeout` | The request took too long | Retry later |
| `aborted` | Your `AbortSignal` fired | Nothing |
| `invalid-response` | OctaP's response couldn't be read | Report it |

:::note
`sign-in-canceled` is a best guess from the page regaining focus, because Google's button doesn't report cancellation. It can fire while the popup is still open if the customer clicks back to the page, and may not fire at all. Use it only to show a message.
:::
