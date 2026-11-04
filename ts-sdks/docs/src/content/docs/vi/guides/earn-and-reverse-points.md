---
title: Earn và đảo điểm
description: Phát điểm cho giao dịch mua, và thu hồi điểm khi hoàn tiền hoặc chargeback.
---

## Earn điểm

Gọi từ server của bạn sau khi khách hàng thanh toán. Hãy gửi số tiền, không phải số điểm: OctaP tự áp dụng tỷ lệ earn của chương trình.

```ts
const earn = await client.earnPoints({
  organizationEndUserId: memberId,
  purchaseAmount: order.totalMinorUnits,
  idempotencyKey: `earn-${order.id}`,
  receiptReference: order.id,
  metadata: { store: 'district-1' },
});
```

`receiptReference` và `metadata` là tùy chọn, và được tính là một phần của request khi dùng lại key.

### Biết khi nào điểm tiêu được

Response có trạng thái `PENDING`. Hãy xử lý webhook [`credits.earn.confirmed`](/vi/reference/webhook-events/#creditsearnconfirmed), hoặc đọc lịch sử:

```ts
const [latest] = await client.listTransactions(memberId, { limit: 1 });
if (latest.status === 'CONFIRMED') {
  showPoints(latest.pointsAmount);
}
```

Lần earn đầu tiên của thành viên cũng mở tài khoản on-chain của họ, nên có thể lâu hơn các lần sau.

### Các trường hợp bị từ chối

| Status | Ý nghĩa |
| --- | --- |
| 400 | Số tiền không hợp lệ, hoặc quá nhỏ để được 1 điểm |
| 403 | Tổ chức hoặc thành viên không hoạt động, hoặc key thiếu `write` |
| 404 | Thành viên không thuộc tổ chức của bạn |
| 409 | Key đã được dùng cho một request khác |
| 422 | Chương trình của tổ chức bạn chưa được provision |

## Đảo giao dịch

Đảo một lệnh earn đã xác nhận sau khi hoàn tiền hoặc chargeback. `reason` là bắt buộc.

```ts
const reversal = await client.reverseTransaction({
  transactionId: earn.transactionId,
  idempotencyKey: `refund-${order.id}`,
  reason: 'Customer returned the order',
});

if (reversal.balanceWentNegative) {
  // Khách đã tiêu số điểm này. Số dư âm là khoản nợ và chặn việc tiêu điểm tiếp.
}
```

Bạn có thể đảo giao dịch `EARN` và `REDEEM` đã xác nhận. Giao dịch `PENDING` không đảo được: nó sẽ được xử lý xong hoặc được giải phóng.

Để đảo một claim voucher trả phí, hãy đảo giao dịch `REDEEM` của nó. Xem phần hoàn tiền trong [Quản lý voucher](/vi/guides/manage-vouchers/).
