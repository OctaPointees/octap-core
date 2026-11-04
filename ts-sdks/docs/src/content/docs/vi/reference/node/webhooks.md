---
title: Webhook
description: Các method Node SDK cho endpoint webhook, delivery và xác minh chữ ký.
---

## registerWebhookEndpoint

Trả về secret, và bạn không đọc lại được. Không idempotent.

`POST /v1/webhooks/endpoints` · Scope: `admin`

```ts
registerWebhookEndpoint(request: RegisterWebhookEndpointRequest, options?): Promise<WebhookEndpointWithSecretDto>
```

| Tham số | Kiểu | Mô tả |
| --- | --- | --- |
| `url` | `string` | **Bắt buộc.** URL `http` hoặc `https`. |
| `description` | `string` | |

Trả về `id`, `organizationId`, `url`, `description`, `status`, `createdAt`, `updatedAt` và `secret`.

## listWebhookEndpoints

Không gồm secret.

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

Trả về secret mới. Không idempotent.

`POST /v1/webhooks/endpoints/:id/rotate-secret` · Scope: `admin`

```ts
rotateWebhookSecret(id: string, options?): Promise<WebhookEndpointWithSecretDto>
```

## listWebhookDeliveries

`GET /v1/webhooks/deliveries` · Scope: `read`

```ts
listWebhookDeliveries(options?): Promise<WebhookDeliveryDto[]>
```

Mỗi delivery có `id`, `endpointId`, `eventType`, `status`, `attemptCount`, `nextAttemptAt`, `lastResponseStatus`, `lastError`, `createdAt` và `updatedAt`.

## replayWebhookDelivery

Xếp lại hàng một delivery đã dead-letter, giữ nguyên event ID.

`POST /v1/webhooks/deliveries/:id/replay` · Scope: `admin`

```ts
replayWebhookDelivery(id: string, options?): Promise<WebhookDeliveryDto>
```

## constructWebhookEvent

Xác minh chữ ký và trả về event có kiểu. Dùng ở phía nhận webhook. Ném `OctaSdkError` nếu chữ ký thiếu hoặc sai.

```ts
constructWebhookEvent(rawBody: string, signature: string | undefined, secret: string): WebhookEvent
```

Truyền đúng raw body, không truyền JSON đã serialize lại. Xem [Webhook events](/vi/reference/webhook-events/).

## verifyWebhookSignature

Kiểm tra chữ ký mà không parse body.

```ts
verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean
```
