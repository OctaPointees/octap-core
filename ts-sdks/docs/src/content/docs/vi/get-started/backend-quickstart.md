---
title: Quickstart cho backend
description: Tạo client và phát điểm từ server của bạn.
---

Phát điểm cho một giao dịch mua và đọc kết quả. Bạn cần một API key có scope `write` và `read`, cùng ID của một thành viên đã đăng ký.

## 1. Tạo client

Tạo một client và dùng lại. Đọc key từ biến môi trường, và không bao giờ gửi nó xuống trình duyệt.

```ts title="octap.ts"
import { createOctaPointClient } from '@octap/sdk';

export const client = createOctaPointClient({
  baseUrl: process.env.OCTAP_API_URL,
  credentials: { apiKey: process.env.OCTAP_API_KEY },
});
```

## 2. Earn điểm cho một giao dịch mua

Gửi số tiền mua theo đơn vị nhỏ nhất của loại tiền, không phải số điểm. Dùng key gắn với giao dịch mua này, ví dụ ID đơn hàng, để việc thử lại không thể phát điểm hai lần.

```ts
const earn = await client.earnPoints({
  organizationEndUserId: memberId,
  purchaseAmount: 100000,
  idempotencyKey: `order-${order.id}`,
  receiptReference: order.id,
});
```

Với tỷ lệ earn 1%, response như sau:

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

`status` là `PENDING` vì lệnh earn đang trên đường lên chain. `newBalance` là số dư đã xác nhận, nên chưa tính lệnh earn này.

## 3. Đọc kết quả

Đọc số dư và lịch sử của thành viên:

```ts
const balance = await client.getBalance(memberId);
// balance.pendingEarn là 1000 cho đến khi chain xác nhận, sau đó balance.confirmedBalance tăng lên.

const history = await client.listTransactions(memberId, { limit: 20 });
```

Trên production, đừng polling. Hãy [nhận webhook](/vi/guides/receive-webhooks/) và xử lý `credits.earn.confirmed`, event này mang số điểm thực sự được cộng.

## 4. Xử lý lỗi

```ts
import { OctaApiError, OctaNetworkError } from '@octap/sdk';

try {
  await client.earnPoints(request);
} catch (error) {
  if (error instanceof OctaApiError && error.statusCode === 400) {
    // Bị từ chối, không có gì xảy ra. Giao dịch quá nhỏ để được 1 điểm cũng rơi vào đây.
  } else if (error instanceof OctaNetworkError) {
    // Request có thể đã tới OctaP. Gửi lại với cùng idempotency key.
  } else {
    throw error;
  }
}
```

## Bước tiếp theo

- [Đăng nhập khách hàng](/vi/get-started/frontend-quickstart/) trên website của bạn
- [Claim voucher trả phí](/vi/guides/claim-a-paid-voucher/), luồng đầy đủ giữa server và trình duyệt
- [Idempotency và phục hồi](/vi/concepts/idempotency-and-recovery/)
