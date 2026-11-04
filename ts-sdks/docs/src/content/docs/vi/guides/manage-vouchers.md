---
title: Quản lý voucher
description: Tạo và sửa voucher, và đặt điều khoản hoàn tiền cho các claim sau này.
---

## Tạo voucher

```ts
const voucher = await client.createVoucher({
  code: 'COFFEE-25',
  title: 'Free coffee',
  pointsCost: 25,
  discountType: 'FREE_ITEM',
  totalSupply: 500,
  expiresAt: '2030-01-01T00:00:00Z',
});
```

`pointsCost` mặc định là 0, tức voucher miễn phí. `status` mặc định là `ACTIVE`, và cũng nhận `DRAFT` hoặc `PAUSED`. `code` phải là duy nhất trong tổ chức của bạn, nếu không bạn nhận 409.

Ngày giờ theo định dạng ISO có giây và múi giờ, ví dụ `2030-01-01T00:00:00Z`.

## Sửa voucher

```ts
await client.updateVoucher(voucher.id, { status: 'PAUSED' });
```

Sau lần claim đầu tiên, `code`, `pointsCost`, loại và giá trị giảm giá, cùng các mốc ngày không đổi được nữa. Bạn vẫn đổi được tiêu đề, mô tả, metadata, số lượng và trạng thái. Số lượng không được thấp hơn số đã claim.

## Đọc voucher

```ts
const vouchers = await client.listVouchers();
const owned = await client.listMemberVouchers(memberId);
```

## Hoàn tiền

Chính sách hoàn tiền đặt điều khoản cho các claim sau này. Mỗi claim giữ một bản sao điều khoản có hiệu lực lúc tạo, nên đổi chính sách không ảnh hưởng đến claim đã có.

```ts
await client.setVoucherRefundPolicy({
  allowUnused: true,
  allowExpired: false,
  allowRedeemed: false,
  restockUnused: true,
  refundWindowDays: 30,
  reason: 'Thirty-day returns',
});
```

| Thiết lập | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `allowUnused` | `true` | Hoàn tiền voucher chưa dùng |
| `allowExpired` | `false` | Hoàn tiền voucher đã hết hạn. Khi thực hiện cần key `admin`. |
| `allowRedeemed` | `false` | Hoàn tiền voucher đã dùng, như một biện pháp hỗ trợ ngoại lệ. Khi thực hiện cần key `admin`. |
| `restockUnused` | `true` | Trả đơn vị về tồn kho. `false` thì đơn vị bị tiêu hao vĩnh viễn. |
| `refundWindowDays` | `null` | Số ngày kể từ lúc claim, không tính ngày biên. `null` là không giới hạn. |

Publish chính sách và đọc lịch sử chính sách cần key `admin`. `getVoucherRefundPolicy` chỉ cần `read`.

Để hoàn tiền một claim, hãy [đảo giao dịch](/vi/guides/earn-and-reverse-points/) `REDEEM` của nó, có ID là `transactionId` của claim. Theo chính sách mặc định:

| Voucher khi đảo | Kết quả |
| --- | --- |
| `RESERVED` | Bị từ chối vì vẫn đang chờ. Thất bại hoặc bị bỏ dở sẽ giải phóng nó. |
| `AVAILABLE`, chưa hết hạn | Bị hủy, trả lại tồn kho và hoàn điểm cùng lúc |
| `REDEEMED` hoặc đã hết hạn | 409. Để đền bù cho thành viên, hãy phát một lệnh earn riêng. |
