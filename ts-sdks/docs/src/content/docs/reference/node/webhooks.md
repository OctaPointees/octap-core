---
title: Webhooks
description: Node SDK methods for webhook endpoints, deliveries and signature verification.
---

The Owner registers, disables, enables and rotates endpoints, and replays dead-lettered deliveries, in the console. No API key can, so the SDK only reads them. See [Receive webhooks](/guides/receive-webhooks/).

## listWebhookEndpoints

Doesn't include secrets.

`GET /v1/webhooks/endpoints` · Scope: `read`

```ts
listWebhookEndpoints(options?): Promise<WebhookEndpointDto[]>
```

## listWebhookDeliveries

`GET /v1/webhooks/deliveries` · Scope: `read`

```ts
listWebhookDeliveries(options?): Promise<WebhookDeliveryDto[]>
```

Each delivery has `id`, `endpointId`, `eventType`, `status`, `attemptCount`, `nextAttemptAt`, `lastResponseStatus`, `lastError`, `createdAt` and `updatedAt`.

## constructWebhookEvent

Verifies the signature and returns the typed event. Use this on your receiver. Throws `OctaSdkError` if the signature is missing or wrong.

```ts
constructWebhookEvent(rawBody: string, signature: string | undefined, secret: string): WebhookEvent
```

Pass the exact raw body, not re-serialized JSON. See [Webhook events](/reference/webhook-events/).

## verifyWebhookSignature

Checks a signature without parsing the body.

```ts
verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean
```
