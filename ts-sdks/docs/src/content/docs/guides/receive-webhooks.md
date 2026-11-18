---
title: Receive webhooks
description: Register an endpoint, verify signatures, and process events exactly once.
---

Webhooks tell your server when something settles, so you don't have to poll.

## 1. Register an endpoint

The organization's Owner registers the endpoint in the console, under **Webhooks**, with an `http` or `https` URL. No API key can register or change one.

The console shows the signing secret once, right after registering, and again only when the Owner rotates it. Store it where your receiver can read it, such as a secret manager. Your server can check what is registered:

```ts
const endpoints = await client.listWebhookEndpoints(); // never includes the secret
```

## 2. Verify and handle events

Verify against the **exact raw body**. Parsing and re-serializing the JSON can change the bytes and break the signature.

```ts title="webhook.ts"
import { constructWebhookEvent } from '@octap/sdk';

app.post('/webhooks/octap', async (req, res) => {
  let event;
  try {
    event = constructWebhookEvent(req.rawBody, req.headers['x-octap-signature'], secret);
  } catch {
    return res.status(401).end();
  }

  // Retries and replays keep the same ID, so skip what you've handled.
  if (await alreadyProcessed(event.id)) return res.status(200).end();

  switch (event.type) {
    case 'credits.earn.confirmed':
      await creditCustomer(event.data.organizationEndUserId, event.data.pointsAmount);
      break;
    case 'voucher.granted':
      await showVoucher(event.data.organizationEndUserId, event.data.serialCode);
      break;
    case 'voucher.redeemed':
      await markUsed(event.data.serialCode);
      break;
  }

  await markProcessed(event.id);
  res.status(200).end();
});
```

`event.data` is typed by `event.type`. See [Webhook events](/reference/webhook-events/).

## Delivery

| Behavior | Detail |
| --- | --- |
| Success | Any 2xx response within 10 seconds |
| Retries | Up to 6 attempts in total, waiting longer each time (1, 2, 5, 15, then 30 minutes) |
| After the last attempt | The delivery becomes `DEAD_LETTER` |
| Replay | The Owner replays a dead-lettered delivery in the console. It is re-queued with the same event ID. |

Each request carries these headers:

| Header | Value |
| --- | --- |
| `x-octap-signature` | Hex HMAC-SHA256 of the raw body, using your secret |
| `x-octap-event-id` | Stable across retries and replays |
| `x-octap-event-type` | Same as the body's `type` |

## Rely on confirmed events

`credits.earned` is best-effort: in rare cases, such as a crash right after accepting an earn, it can be lost. The confirmed events are queued in the same database transaction as the change they report, so build your logic on those.

## Manage endpoints

The Owner disables, enables and rotates the secret of an endpoint in the console. Rotating stops the old secret at once, so update your receiver's secret straight after. Your server can follow deliveries:

```ts
const deliveries = await client.listWebhookDeliveries();
```
