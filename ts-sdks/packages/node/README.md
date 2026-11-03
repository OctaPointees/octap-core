# Node merchant SDK
`src/client.ts` is the merchant client (points and vouchers) over the REST transport in
`src/transports/`. `src/errors/` holds `OctaSdkError` and `OctaApiError`. `src/webhooks.ts` is
the receiver side: `verifyWebhookSignature` checks `x-octap-signature`, and
`constructWebhookEvent` checks it and returns the typed `WebhookEvent` (discriminated on `type`).
Public DTOs come from the sibling contracts package. Do not import this package into browser code;
browser helpers have their own package.

## Verifying a customer

Your frontend gets an id_token from the browser SDK and sends it to your backend. Check it before
acting for that customer, like Firebase Admin's `verifyIdToken`:

```ts
const { endUserId, suiAddress, memberId } = await client.verifyCustomer(idToken);
if (!memberId) {
  // A valid Google sign-in that has not enrolled in your organization yet.
}
```

An invalid or expired token throws `OctaApiError` with status 401. The call needs the `read` scope
and writes nothing. Every merchant shares one OctaP Google client ID, so a token a customer showed
to another merchant also verifies here: treat it as proof of who the customer is, and keep spending
behind the customer's signature.
