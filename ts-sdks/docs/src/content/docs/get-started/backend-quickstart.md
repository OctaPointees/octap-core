---
title: Backend quickstart
description: Create a client and issue points from your server.
---

Issue points for a purchase and read the result. You need an API key with the `write` and `read` scopes, and the ID of an enrolled member.

## 1. Create a client

Create one client and reuse it. Read the key from your environment, and never send it to a browser.

```ts title="octap.ts"
import { createOctaPointClient } from '@octap/sdk';

export const client = createOctaPointClient({
  baseUrl: process.env.OCTAP_API_URL,
  credentials: { apiKey: process.env.OCTAP_API_KEY },
});
```

## 2. Earn points for a purchase

Send the purchase amount in the currency's smallest unit, not a point count. Use a key that belongs to this purchase, such as your order ID, so a retry can't issue points twice.

```ts
const earn = await client.earnPoints({
  organizationEndUserId: memberId,
  purchaseAmount: 100000,
  idempotencyKey: `order-${order.id}`,
  receiptReference: order.id,
});
```

At a 1% earn rate, the response is:

```json
{
  "transactionId": "…",
  "organizationEndUserId": "…",
  "purchaseAmount": 100000,
  "estimatedPoints": 1000,
  "pointsEarned": null,
  "newBalance": 0,
  "status": "PENDING",
  "idempotencyKey": "order-42"
}
```

`status` is `PENDING` because the earn is on its way to the chain. `newBalance` is the confirmed balance, which doesn't include it yet.

## 3. Read the result

Read the member's balance and history:

```ts
const balance = await client.getBalance(memberId);
// balance.pendingEarn is 1000 until the chain confirms, then balance.confirmedBalance grows.

const history = await client.listTransactions(memberId, { limit: 20 });
```

For production, don't poll. [Receive webhooks](/guides/receive-webhooks/) and act on `credits.earn.confirmed`, which carries the points actually credited.

## 4. Handle failure

```ts
import { OctaApiError, OctaNetworkError } from '@octap/sdk';

try {
  await client.earnPoints(request);
} catch (error) {
  if (error instanceof OctaApiError && error.statusCode === 400) {
    // Refused, nothing happened. A purchase too small to earn one point also lands here.
  } else if (error instanceof OctaNetworkError) {
    // The request may have reached OctaP. Repeat it with the same idempotency key.
  } else {
    throw error;
  }
}
```

## Next steps

- [Sign customers in](/get-started/frontend-quickstart/) on your website
- [Claim a paid voucher](/guides/claim-a-paid-voucher/), the full flow across server and browser
- [Idempotency and recovery](/concepts/idempotency-and-recovery/)
