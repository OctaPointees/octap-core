# @octap/sdk

Server-side Node.js SDK for the Octap Core loyalty API: earn and redeem points, manage vouchers,
verify customers and receive webhooks. Run it on your backend only. The API key it holds must never
reach a browser; customer sign-in and signing are in `@octap/browser-sdk`.

```bash
npm install @octap/sdk
```

## Create a client

Create one client and reuse it. Set `baseUrl` to your Octap Core API: without it, the client calls
`http://localhost:3000`.

```ts
import { createOctaPointClient } from '@octap/sdk';

export const client = createOctaPointClient({
  baseUrl: process.env.OCTAP_API_URL,
  credentials: { apiKey: process.env.OCTAP_API_KEY },
});
```

A `read` key is enough for every read. Every other call needs a `write` key. Every method takes an
optional last argument, `RequestOptions`: `{ organizationId, signal }`.

## Verifying a customer

Your frontend gets an id_token from the browser SDK and sends it to your backend. Check it before
acting for that customer, as you would with Firebase Admin's `verifyIdToken`:

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
to another merchant also verifies here. Treat it as proof of who the customer is, not as consent to
anything, and keep every spend behind the customer's signature.

## Methods

| Core routes | SDK methods |
| --- | --- |
| `POST /v1/identity/verify` | `verifyCustomer(idToken)` |
| `POST /v1/credits/earn` | `earnPoints({ organizationEndUserId, purchaseAmount, idempotencyKey, campaignId? })` |
| `GET /v1/campaigns` | `listCampaigns({ live? })` |
| `GET /v1/campaigns/:id` | `getCampaign(campaignId)` |
| `POST /v1/credits/redeem/reserve`, `/finalize` | `reservePosRedemption`, `finalizePosRedemption` |
| `POST /v1/credits/transactions/:id/reverse` | `reverseTransaction` |
| `GET /v1/credits/members/:id/balance`, `/transactions` | `getBalance`, `listTransactions` |
| `GET /v1/credits/budget` | `getIssuanceBudget` |
| `GET /v1/credits/transactions` | `listOrganizationTransactions({ type, status, memberId, limit, cursor })` |
| `GET /v1/credits/program` | `getProgram` |
| `GET /v1/credits/members/:id/reconciliation` | `getBalanceReconciliation` |
| `GET /v1/rewards/refund-policy`, `GET .../history` | `getVoucherRefundPolicy`, `listVoucherRefundPolicyHistory` |
| `POST/GET /v1/rewards/vouchers`, `GET/PATCH .../:id` | `createVoucher`, `listVouchers`, `getVoucher`, `updateVoucher` |
| `POST/GET /v1/rewards/voucher-batches`, `GET .../:id` | `createVouchers(items, { dryRun, name, campaignId })`, `listVoucherBatches`, `getVoucherBatch` |
| `POST .../voucher-batches/:id/activate`, `/pause`, `/resume`, `/archive` | `activateVoucherBatch`, `pauseVoucherBatch`, `resumeVoucherBatch`, `archiveVoucherBatch` |
| `POST .../vouchers/:id/claim`, `GET .../claims/:id` | `claimVoucher`, `getVoucherClaim` |
| `POST .../vouchers/:id/grant` | `grantVoucher` |
| `POST .../vouchers/use`, `/use/finalize` | `prepareVoucherUse`, `finalizeVoucherUse` |
| `GET .../members/:id/vouchers` | `listMemberVouchers` |
| `GET /v1/webhooks/endpoints` | `listWebhookEndpoints` |
| `GET /v1/webhooks/deliveries` | `listWebhookDeliveries` |

- **Finalize routes.** `finalizeVoucherClaim` is an alias for the POS finalize route. The customer's
  signature authorizes every finalize, so the merchant key isn't what permits it.
- **`getBalance` has two forms.** `getBalance(memberId)` returns the `CreditBalanceSnapshot`.
  `getBalance(programId, memberId)` returns the older `BalanceSnapshot`, with snake_case string
  fields, and answers 404 for a program outside your organization.
- **What stays in the console.** The Owner registers, disables, enables and rotates webhook
  endpoints, replays deliveries, and publishes the refund policy there, not with a key. These were
  removed from the SDK in 0.2.0; see `CHANGELOG.md`. List responses never include a webhook secret.

### Voucher CSV

`parseVoucherCsv(text, { utcOffset })` reads a CSV in the Octap voucher template, the file the
console imports, into items for `createVouchers`. It runs the console's checks: each bad row is
reported with its line and column, and left out. `VOUCHER_CSV_TEMPLATE`, `VOUCHER_CSV_TYPES`,
`VOUCHER_BENEFIT_SCHEMA` and `suggestVoucherCode` are exported too.

## On-chain evidence

Every confirmed point movement is a Sui transaction. These reads let you show customers that proof,
or check it yourself:

- `listOrganizationTransactions` is your whole organization's history, newest first. Each confirmed
  row has its `blockchainDigest` and `confirmedAt`; link the digest to a Sui explorer.
- `getProgram` returns your earn rules as published on Sui. `policyStatus: 'MATCH'` means they are
  the rules OctaP applies.
- `getBalanceReconciliation(memberId)` compares the balance OctaP records with what the member's
  `CreditAccount` on Sui can spend. `PENDING` means something is still on its way to the chain, so ask
  again shortly. `MISMATCH` means nothing is in flight and the two differ.

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

- **Rejected earns.** A purchase too small to earn a point is a 400. An earn the issuance budget
  can't cover is a 422.
- **Failed earns.** An accepted earn that fails sends `credits.earn.failed`. Its key stays used, so
  a retry needs a new key.
- **Until the chain confirms.** History shows `pointsAmount: null` and a separate
  `estimatedPoints`. Core has no operation-status route: watch transactions, the balance,
  `getVoucherClaim` or webhooks.
- **Debiting points.** Call `reservePosRedemption`, have the customer sign the returned bytes, then
  call `finalizePosRedemption`.

## Webhooks

Read the raw body, not parsed JSON, and pass it with the `x-octap-signature` header and your
endpoint's secret. `constructWebhookEvent` checks the signature and returns a `WebhookEvent` typed on
`type`. It throws `OctaSdkError` when the signature is missing or doesn't match. `verifyWebhookSignature` only checks it.

```ts
import { constructWebhookEvent } from '@octap/sdk';

app.post('/webhooks/octap', express.raw({ type: 'application/json' }), (req, res) => {
  const event = constructWebhookEvent(req.body.toString('utf8'), req.header('x-octap-signature'), secret);
  if (event.type === 'voucher.redeemed') deliverBenefit(event.data);
  res.sendStatus(200);
});
```

Deduplicate on `event.id`: retries and replays keep the same id.

## Errors, cancellation and retries

- **Errors.** `OctaApiError` exposes `statusCode`, `statusText`, `responseBody`, and `retryAfter`
  when Core sent that header. `OctaNetworkError` keeps the original `cause`.
  `OctaRequestAbortedError` tells a cancellation apart from a server rejection. All three extend
  `OctaSdkError`. Do not log raw bodies, tokens, signatures or API keys.
- **Cancellation.**

  ```ts
  const controller = new AbortController();
  await client.getBalance(memberId, { signal: controller.signal });
  // controller.abort() stops waiting locally; it does not roll back Core or the chain.
  ```

- **Retries.** The SDK never retries by itself.
  - Retry reads with bounded backoff, and wait `retryAfter` on a 429.
  - For an earn, a reserve, a reversal, a claim or a voucher use, retry with the same idempotency
    key and the same request. A retry returns the original result. A changed request under a used
    key is a 409.
- **Unknown outcomes.** After a timeout, a cancellation, a network failure or a 5xx, read the
  persisted state first: the request may have committed. Never switch to a new key to recover from
  an unknown outcome.
- **Finalize.** Reuse the original signature and digest, or read the existing claim or voucher.
