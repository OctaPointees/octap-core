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

### Nhân điểm bằng campaign

Owner có thể chạy một campaign có thời hạn trên console, ví dụ "cuối tuần x2 điểm". Lấy các campaign đang chạy bằng [`listCampaigns({ live: true })`](/vi/reference/node/credits/#listcampaigns), cho thu ngân chọn, rồi gửi id của nó:

```ts
await client.earnPoints({
  organizationEndUserId: memberId,
  purchaseAmount: order.totalMinorUnits,
  idempotencyKey: `earn-${order.id}`,
  campaignId: weekendCampaignId,
});
```

Số điểm là `floor(purchaseAmount × earnBps × multiplierBps ÷ 10⁸)`: 100.000 với 100 basis point và x2 (`multiplierBps` 20000) được 2.000 điểm. Hệ số tối đa là x10, được chain kiểm tra, và điểm nhân thêm vẫn trừ vào [ngân sách phát hành](/vi/concepts/issuance-budget/).

OctaP không bao giờ tự chọn campaign, và mỗi lệnh earn chỉ áp dụng tối đa một campaign. Nếu campaign không `ACTIVE`, nằm ngoài thời hạn, hoặc không có hệ số nhân, lệnh earn bị từ chối với 422 thay vì earn theo tỷ lệ thường, nên máy POS cấu hình sai lộ ra ngay. `campaignId` là một phần của request khi dùng lại key: thử lại với campaign khác trả 409.

Thời hạn của campaign chỉ quyết định những lệnh earn nào được nhân điểm. Voucher trong campaign giữ hạn nhận (`expiresAt`) và thời gian dùng (`validForDays`) của riêng nó: muốn voucher kết thúc cùng campaign, hãy đặt `expiresAt` trùng với ngày kết thúc.

### Biết khi nào điểm tiêu được

Response có trạng thái `PENDING`. Hãy xử lý webhook [`credits.earn.confirmed`](/vi/reference/webhook-events/#creditsearnconfirmed), hoặc đọc lịch sử:

```ts
const {
  items: [latest],
} = await client.listTransactions(memberId, { limit: 1 });
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
| 422 | Chương trình của tổ chức bạn chưa được provision, hoặc [ngân sách phát hành](/vi/concepts/issuance-budget/) không đủ cho lệnh earn này |

### Khi lệnh earn thất bại

Lệnh earn đã được nhận vẫn có thể thất bại trên chain. Khoản giữ được giải phóng, không có gì được cộng, và bạn nhận webhook [`credits.earn.failed`](/vi/reference/webhook-events/#creditsearnfailed).

Key vẫn được tính là đã dùng, nên gửi lại request sẽ trả về đúng kết quả `FAILED` đó. Lệnh earn `FAILED` chắc chắn không cộng gì, nên có thể an toàn thử lại với key **mới**. Chỉ làm vậy với `FAILED`: sau timeout hoặc trạng thái `PENDING`, hãy giữ nguyên key.

## Đảo giao dịch

Đảo một lệnh earn đã xác nhận sau khi hoàn tiền hoặc chargeback. `reason` là bắt buộc.

```ts
const reversal = await client.reverseTransaction({
  transactionId: earn.transactionId,
  idempotencyKey: `refund-${order.id}`,
  reason: 'Customer returned the order',
});
```

Bạn có thể đảo giao dịch `EARN` và `REDEEM` đã xác nhận. Một lệnh `EARN` chỉ đảo được khi toàn bộ số điểm của nó chưa bị tiêu, không bị một lệnh đổi điểm đang chờ giữ lại, và còn hơn 10 phút mới hết hạn, giống quy tắc trên chain. Nếu không, lệnh trả `409`, và bạn bù cho khách ngoài sổ cái. Giao dịch `PENDING` không đảo được: nó sẽ được xử lý xong hoặc được giải phóng.

Để đảo một claim voucher trả phí, hãy đảo giao dịch `REDEEM` của nó. Xem phần hoàn tiền trong [Quản lý voucher](/vi/guides/manage-vouchers/).
