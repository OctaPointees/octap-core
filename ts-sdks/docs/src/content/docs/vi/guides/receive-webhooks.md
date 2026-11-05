---
title: Nhận webhook
description: Đăng ký endpoint, xác minh chữ ký và xử lý mỗi event đúng một lần.
---

Webhook báo cho server của bạn khi có việc đã hoàn tất, nên bạn không phải polling.

## 1. Đăng ký endpoint

Lệnh này cần key `admin`. Secret chỉ được trả về ở đây và khi bạn rotate, nên hãy lưu an toàn.

```ts
const endpoint = await client.registerWebhookEndpoint({
  url: 'https://shop.example/webhooks/octap',
  description: 'Production orders',
});
saveSecret(endpoint.secret);
```

Đừng thử lại lệnh này một cách mù quáng, vì nó không idempotent. Hãy liệt kê endpoint của bạn trước.

## 2. Xác minh và xử lý event

Xác minh trên **đúng raw body**. Parse rồi serialize lại JSON có thể làm đổi các byte và hỏng chữ ký.

```ts title="webhook.ts"
import { constructWebhookEvent } from '@octap/sdk';

app.post('/webhooks/octap', async (req, res) => {
  let event;
  try {
    event = constructWebhookEvent(req.rawBody, req.headers['x-octap-signature'], secret);
  } catch {
    return res.status(401).end();
  }

  // Retry và replay giữ nguyên ID, nên bỏ qua những gì đã xử lý.
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

Kiểu của `event.data` phụ thuộc vào `event.type`. Xem [Webhook events](/vi/reference/webhook-events/).

## Cách gửi

| Hành vi | Chi tiết |
| --- | --- |
| Thành công | Bất kỳ response 2xx nào trong vòng 10 giây |
| Thử lại | Tối đa 6 lần tổng cộng, chờ lâu dần mỗi lần (1, 2, 5, 15, rồi 30 phút) |
| Sau lần cuối | Delivery chuyển thành `DEAD_LETTER` |
| Replay | `replayWebhookDelivery(id)` xếp lại hàng delivery đã dead-letter, giữ nguyên event ID |

Mỗi request có các header sau:

| Header | Giá trị |
| --- | --- |
| `x-octap-signature` | HMAC-SHA256 dạng hex của raw body, dùng secret của bạn |
| `x-octap-event-id` | Không đổi qua các lần retry và replay |
| `x-octap-event-type` | Giống `type` trong body |

## Dựa vào event đã xác nhận

`credits.earned` là best-effort: trong trường hợp hiếm, như server sập ngay sau khi nhận lệnh earn, event này có thể mất. Các event đã xác nhận được xếp hàng trong cùng database transaction với thay đổi mà chúng báo, nên hãy xây logic trên các event đó.

## Quản lý endpoint

```ts
await client.disableWebhookEndpoint(endpoint.id);
await client.enableWebhookEndpoint(endpoint.id);

const { secret: newSecret } = await client.rotateWebhookSecret(endpoint.id);

const deliveries = await client.listWebhookDeliveries();
```
