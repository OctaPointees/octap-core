---
title: Webhooks
description: Node SDK methods for webhook endpoints, deliveries and signature verification.
---

## registerWebhookEndpoint

Returns the secret, which you can't read again. Not idempotent.

`POST /v1/webhooks/endpoints` · Scope: `admin`

```ts
registerWebhookEndpoint(request: RegisterWebhookEndpointRequest, options?): Promise<WebhookEndpointWithSecretDto>
```

| Parameter | Type | Description |
| --- | --- | --- |
| `url` | `string` | **Required.** An `http` or `https` URL. |
| `description` | `string` | |

Returns `id`, `organizationId`, `url`, `description`, `status`, `createdAt`, `updatedAt` and `secret`.

## listWebhookEndpoints

Doesn't include secrets.

`GET /v1/webhooks/endpoints` · Scope: `read`

```ts
listWebhookEndpoints(options?): Promise<WebhookEndpointDto[]>
```

## disableWebhookEndpoint

`POST /v1/webhooks/endpoints/:id/disable` · Scope: `admin`

```ts
disableWebhookEndpoint(id: string, options?): Promise<WebhookEndpointDto>
```

## enableWebhookEndpoint

`POST /v1/webhooks/endpoints/:id/enable` · Scope: `admin`

```ts
enableWebhookEndpoint(id: string, options?): Promise<WebhookEndpointDto>
```

## rotateWebhookSecret

Returns a new secret. Not idempotent.

`POST /v1/webhooks/endpoints/:id/rotate-secret` · Scope: `admin`

```ts
rotateWebhookSecret(id: string, options?): Promise<WebhookEndpointWithSecretDto>
```

## listWebhookDeliveries

`GET /v1/webhooks/deliveries` · Scope: `read`

```ts
listWebhookDeliveries(options?): Promise<WebhookDeliveryDto[]>
```

Each delivery has `id`, `endpointId`, `eventType`, `status`, `attemptCount`, `nextAttemptAt`, `lastResponseStatus`, `lastError`, `createdAt` and `updatedAt`.

## replayWebhookDelivery

Re-queues a dead-lettered delivery with the same event ID.

`POST /v1/webhooks/deliveries/:id/replay` · Scope: `admin`

```ts
replayWebhookDelivery(id: string, options?): Promise<WebhookDeliveryDto>
```

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
