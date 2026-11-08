---
title: Redeem điểm khi thanh toán
description: Cho khách hàng tiêu điểm trực tiếp tại điểm bán hàng.
---

Dùng khi khách hàng trả bằng điểm thay vì voucher. Luồng này giống claim voucher trả phí: server của bạn giữ chỗ, và khách hàng ký.

## 1. Giữ chỗ trên server

`pointsAmount` ở đây là số điểm thật.

```ts
const reservation = await client.reservePosRedemption({
  organizationEndUserId: memberId,
  pointsAmount: 500,
  idempotencyKey: `pos-${order.id}`,
  orderReference: order.id,
  discountAmount: 50000,
  currency: 'VND',
});
```

`orderReference`, `discountAmount` và `currency` cho biết số điểm này đổi lấy gì. Chúng được hash vào giao dịch khách hàng ký, nên chain ghi lại mỗi lần tiêu điểm đổi lấy đơn hàng và mức giảm nào. Hãy cho khách hàng xem đúng mức giảm đó trước khi ký. `orderReference` không được chứa dữ liệu cá nhân.

Gửi `digest` và `transactionBytes` xuống thiết bị của khách hàng. Nếu key này đã được xử lý xong, cả hai là `null` và `status` cho biết kết quả.

Thành viên cần đủ điểm khả dụng, địa chỉ Sui đã liên kết và tài khoản on-chain, được tạo ở lần earn đầu tiên. Nếu không, bạn nhận 400.

## 2. Ký trên thiết bị của khách hàng

```ts
const signature = await auth.signTransaction(reservation.transactionBytes);
```

`signTransaction` từ chối bytes có người gửi không phải khách hàng đang đăng nhập, với mã `wrong-account`.

## 3. Finalize

Gửi chữ ký về server và finalize ở đó, hoặc finalize từ thiết bị của khách hàng. Chữ ký xác nhận lệnh này, không phải API key của bạn.

```ts
const result = await client.finalizePosRedemption({
  digest: reservation.digest,
  signature,
});
// result.pointsRedeemed, result.newBalance, result.blockchainDigest
```

Ở đây hãy dùng hai lệnh gọi này. `auth.signAndFinalize` chỉ nhận claim voucher, vì nó yêu cầu `status: 'RESERVED'`, còn trạng thái của lần giữ chỗ này là `PENDING`.

## Khi có sự cố

| Bạn thấy | Cần làm |
| --- | --- |
| 404 khi finalize | Lần giữ chỗ đã hết hạn, hoặc đã finalize. Đọc lịch sử trước khi giữ chỗ lại. |
| 409 khi finalize | Đã được giải phóng hoặc có digest khác đang xử lý. Đọc lịch sử trước. |
| 400 khi finalize | Có thể đã thất bại on-chain hoặc sau khi gửi. Đọc lịch sử trước khi thử lại. |
| Timeout hoặc 5xx | Chưa rõ kết quả. Đọc lịch sử, hoặc giữ chỗ lại với cùng key. |

Khoản giữ không bao giờ được ký sẽ được giải phóng sau 30 phút.
