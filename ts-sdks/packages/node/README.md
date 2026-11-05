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
const { suiAddress, memberId, active } = await client.verifyCustomer(idToken);
if (!memberId) {
  // A valid Google sign-in that has not enrolled in your organization yet.
} else if (!active) {
  // Enrolled, but blocked: reward operations for this member will be refused.
}
```

An invalid or expired token throws `OctaApiError` with status 401. The call needs the `read` scope
and writes nothing. Every merchant shares one OctaP Google client ID, so a token a customer showed
to another merchant also verifies here: treat it as proof of who the customer is, not of consent to
anything, and keep spending behind the customer's signature.

## Merchant methods

Keep the API key on a trusted Node server. Console/platform session routes and API credential
management are outside this client. Every method accepts `RequestOptions` with `organizationId`
and `signal`, including both balance overloads.

| Core routes | SDK methods |
| --- | --- |
| `POST /v1/credits/earn` | `earnPoints({ organizationEndUserId, purchaseAmount, idempotencyKey })` |
| `POST /v1/credits/redeem/reserve`, `/finalize` | `reservePosRedemption`, `finalizePosRedemption` |
| `POST /v1/credits/transactions/:id/reverse` | `reverseTransaction` |
| `GET /v1/credits/members/:id/balance`, `/transactions` | `getBalance`, `listTransactions` |
| `GET /v1/credits/budget` | `getIssuanceBudget` |
| `GET/PUT /v1/rewards/refund-policy`, `GET .../history` | `getVoucherRefundPolicy`, `setVoucherRefundPolicy`, `listVoucherRefundPolicyHistory` |
| `POST/GET /v1/rewards/vouchers`, `GET/PATCH .../:id` | `createVoucher`, `listVouchers`, `getVoucher`, `updateVoucher` |
| `POST .../vouchers/:id/claim`, `GET .../claims/:id` | `claimVoucher`, `getVoucherClaim` |
| `POST .../vouchers/:id/grant` | `grantVoucher` |
| `POST .../vouchers/use`, `/use/finalize` | `prepareVoucherUse`, `finalizeVoucherUse` |
| `GET .../members/:id/vouchers` | `listMemberVouchers` |
| `POST/GET /v1/webhooks/endpoints` | `registerWebhookEndpoint`, `listWebhookEndpoints` |
| `POST .../endpoints/:id/disable`, `/enable`, `/rotate-secret` | `disableWebhookEndpoint`, `enableWebhookEndpoint`, `rotateWebhookSecret` |
| `GET /v1/webhooks/deliveries`, `POST .../:id/replay` | `listWebhookDeliveries`, `replayWebhookDelivery` |

`finalizeVoucherClaim` is an alias for the shared finalize route. Customer signatures authorize
finalization; no merchant credential is needed there. Webhook mutations and refund policy publication/
history require an admin-scoped key. Store register/rotate secrets securely; list responses omit them.

## Earn

```ts
const accepted = await client.earnPoints({
  organizationEndUserId: memberId,
  purchaseAmount: 100000,
  idempotencyKey: 'purchase-order-42',
});
// At 100 bps: estimatedPoints=1000, pointsEarned=null, status=PENDING.
// Read listTransactions or consume credits.earn.confirmed for the actual point result.
```

A purchase too small to earn a point is rejected with 400, and an earn the issuance budget cannot cover with 422. An accepted earn that fails sends `credits.earn.failed`; its key stays used, so a retry needs a new key. History shows `pointsAmount: null` and a
separate `estimatedPoints` until the chain confirms. Core has no operation-status route: observe
transactions, balance, `getVoucherClaim` or webhooks. To debit points, use `reservePosRedemption`,
return the bytes to the customer to sign, then call `finalizePosRedemption`.
`getBalance(programId, memberId, options)` returns 404 for a program outside your organization.

## Errors, cancellation and retries

`OctaApiError` exposes `statusCode`, `statusText`, `responseBody`, and `retryAfter` when Core sent
that header. `OctaNetworkError` preserves the original `cause`. `OctaRequestAbortedError` distinguishes
cancellation from server rejection. Do not log raw bodies, tokens, signatures or API keys.

```ts
const controller = new AbortController();
await client.getBalance(memberId, { signal: controller.signal });
// controller.abort() cancels local waiting; it does not roll back Core or the chain.
```

The SDK performs no automatic retries. Retry reads with bounded backoff, and wait `retryAfter` on a 429.
For earn, reserve, reversal and claim retries, keep the same idempotency key and the same request: a
retry returns the original transaction, and a changed request under a used key returns 409. After a timeout, cancellation,
network failure or 5xx, read persisted state first, because the request may have committed. Never switch
to a new key to recover an unknown outcome. Finalize must reuse the original signature and digest, or
read the existing claim. Voucher redemption has no idempotency key: read its ownership status before
retrying. Webhook registration and secret rotation are not idempotent, so do not blindly retry them.
