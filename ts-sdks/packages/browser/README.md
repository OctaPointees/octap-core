# @octap/browser-sdk

Customer sign-in and transaction signing for a merchant's website, added the way you would add
Firebase Auth. You never handle OAuth nonces, ephemeral keys, ZK proofs or Enoki.

This package holds no merchant credential. Balance, history, voucher lists and claims need your API
key, so they stay on your backend through `@octap/sdk`.

## Sign a customer in

```ts
import { createOctapAuth } from '@octap/browser-sdk';

const auth = createOctapAuth({ apiBaseUrl, organizationId, googleClientId });

auth.onAuthStateChanged((user) => {
  // { endUserId, memberId, suiAddress } or null. Also called once on load, after a reload restores.
});

await auth.renderGoogleButton(document.getElementById('sign-in'), {
  onError: (error) => showMessage(error.message),
});
```

Signing in also enrolls the customer in your organization. The button renders nothing while a
customer is signed in, and returns after they sign out or their session expires.

## Prove the customer to your backend

Send the token to your backend, and check it there with `verifyCustomer` from `@octap/sdk`. Never
trust a member ID your frontend sends on its own.

```ts
const response = await fetch('/api/claim', {
  method: 'POST',
  headers: { authorization: `Bearer ${await auth.getIdToken()}` },
  body: JSON.stringify({ voucherId }),
});
```

## Claim a paid voucher

Your backend calls `claimVoucher` and returns the result. The customer's device then signs it:

```ts
const claim = await response.json();
if (claim.status === 'RESERVED') {
  await auth.signAndFinalize(claim);
}
```

Follow these rules, whatever your interface looks like:

- A RESERVED voucher is not owned yet. Show it as pending until finalize succeeds.
- `signAndFinalize` never retries by itself. On `outcome-unknown`, the transaction may still land.
  Read the claim from your backend, or claim again with the **same** idempotency key.
- Use a new idempotency key only after the claim is CANCELLED.

`auth.signTransaction(transactionBytes)` is the lower-level call: it returns the zkLogin signature
and sends nothing. It refuses bytes whose sender is not the signed-in customer.

## Errors

Every failure is an `OctapAuthError` with a `code`. API errors also have `status` and `body`.

| Code                   | Meaning                                                 | What to do                       |
| ---------------------- | ------------------------------------------------------- | -------------------------------- |
| `sign-in-canceled`     | The customer closed Google's window                     | Nothing; the button still works  |
| `nonce-mismatch`       | Google's token was not issued for this attempt          | Ask them to sign in again        |
| `provider-unavailable` | Google's script could not load                          | Check for blocked scripts        |
| `not-signed-in`        | No customer is signed in                                | Show the button                  |
| `session-expired`      | The signing session passed `maxEpoch`                   | Ask them to sign in again        |
| `token-expired`        | Google's token expired (after about an hour)            | Ask them to sign in again        |
| `wrong-account`        | The transaction belongs to a different customer         | Ask them to use that account     |
| `invalid-claim`        | The claim has nothing to sign, or its bytes are invalid | Check the claim's status         |
| `outcome-unknown`      | Finalize may have reached the chain                     | Read the claim; do not re-create |
| `api-error`            | OctaP answered with an error                            | See `status` and `message`       |
| `network-error`        | OctaP could not be reached                              | Retry later                      |
| `timeout`              | The request took too long                               | Retry later                      |
| `aborted`              | Your `AbortSignal` fired                                | Nothing                          |
| `invalid-response`     | OctaP's response could not be read                      | Report it                        |

`sign-in-canceled` depends on the browser returning focus when Google's popup closes, because
Google's button reports no cancellation itself. Do not rely on it for anything beyond a message.

## Security

The session holds the ephemeral signing key, the proof and the id_token until `maxEpoch` or sign-out.

- By default these are in `sessionStorage`, so they survive a reload in this tab. Any script on your
  page can read them, so an XSS flaw lets an attacker sign as this customer until the session
  expires. Use a strict Content Security Policy, and avoid third-party scripts on these pages.
- Pass `persistence: 'memory'` to keep them out of browser storage. A reload then signs the customer
  out.
- The private key is never sent anywhere. Only its public half reaches OctaP.

## Google client ID

Use the Google client ID OctaP gives you, and ask OctaP to add your site's origin to it. All merchants
share this client for now, so moving to per-merchant clients later would change customer wallets.

## Local example

See [the browser auth example](../../examples/README.md#browser-auth-example) for a runnable page.
