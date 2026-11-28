---
title: Webhook
description: Các method Node SDK cho endpoint webhook, delivery và xác minh chữ ký.
---

Trên Console, Owner đăng ký, tắt, bật, xoay secret của endpoint, còn Owner hoặc Business Developer gửi lại delivery đã dead-letter. Không API key nào làm được, nên SDK chỉ đọc. Xem [Nhận webhook](/vi/guides/receive-webhooks/).

## listWebhookEndpoints

Không gồm secret.

`GET /v1/webhooks/endpoints` · Scope: `read`

```ts
listWebhookEndpoints(options?): Promise<WebhookEndpointDto[]>
```

## listWebhookDeliveries

`GET /v1/webhooks/deliveries` · Scope: `read`

```ts
listWebhookDeliveries(options?): Promise<WebhookDeliveryDto[]>
```

Mỗi delivery có `id`, `endpointId`, `eventType`, `status`, `attemptCount`, `nextAttemptAt`, `lastResponseStatus`, `lastError`, `createdAt` và `updatedAt`.

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
