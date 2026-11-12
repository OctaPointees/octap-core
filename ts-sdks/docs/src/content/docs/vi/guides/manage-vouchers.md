---
title: Quản lý voucher
description: Publish voucher theo hình thức của bạn, tặng voucher và đặt điều khoản hoàn tiền.
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

Nếu lệnh tạo bị timeout hoặc mất response, voucher có thể vẫn đã được tạo, và gọi lại sẽ nhận 409 vì trùng `code`. Khi đó, hãy gọi `listVouchers` và tìm voucher theo `code`, thay vì tạo lại.

### Publish

Yêu cầu `ACTIVE` sẽ publish điều khoản của voucher lên chain, nơi không ai đổi được nữa. Trước khi chain xác nhận, voucher ở `DRAFT` với `publishStatus: 'PUBLISHING'` và chưa claim được. Hãy đọc cho đến khi `publishStatus` là `PUBLISHED`. Nếu là `FAILED`, bạn có thể sửa và kích hoạt lại. Tổ chức của bạn cần có program đã provision, nếu không bạn nhận 422.

### Hình thức voucher của riêng bạn

Voucher của bạn không nhất thiết phải là một loại giảm giá của OctaP. Hãy mô tả nó trong `terms` theo cách phù hợp với doanh nghiệp, và bỏ `discountType`:

```ts
await client.createVoucher({
  code: 'SPA-TET',
  title: 'Tet spa package',
  pointsCost: 500,
  terms: { benefit: 'Two treatments for one', weekdaysOnly: true },
});
```

Điều khoản, tiêu đề và mô tả phải vừa trong 8 KB. Chúng công khai trên chain, nên không được chứa dữ liệu cá nhân.

Ngày giờ theo định dạng ISO có giây và múi giờ, ví dụ `2030-01-01T00:00:00Z`.

## Sửa voucher

```ts
await client.updateVoucher(voucher.id, { status: 'PAUSED' });
```

Từ khi bắt đầu publish, `code`, `title`, `description`, `pointsCost`, `terms`, loại và giá trị giảm giá, cùng các mốc ngày không đổi được nữa. Muốn ưu đãi khác, hãy tạo voucher mới. Bạn vẫn đổi được metadata, số lượng và trạng thái. Số lượng không thể thấp hơn số đã claim.

## Tặng voucher

Hãy tặng voucher khi khách hàng không cần tiêu điểm, ví dụ quà tặng hoặc phần thưởng chiến dịch. Cách phát là do bạn: QR, link hay sự kiện đều có thể dẫn đến lệnh này.

```ts
await client.grantVoucher(voucher.id, {
  organizationEndUserId: memberId,
  idempotencyKey: `gift-${campaignId}-${memberId}`,
});
```

Voucher ở `RESERVED` cho đến khi chain ghi nhận, rồi `voucher.granted` được gửi đến. Khách hàng không cần ký để nhận, nhưng phải ký để dùng. Voucher đã tặng không thể bị thu hồi.

## Đọc voucher

```ts
const vouchers = await client.listVouchers();
const owned = await client.listMemberVouchers(memberId);
```

## Hoàn tiền

Voucher publish kèm chính sách hoàn tiền có hiệu lực lúc bắt đầu publish, nên nó là một phần của lời hứa. Đổi chính sách chỉ ảnh hưởng đến các voucher publish sau đó.

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
| Đang có lượt dùng | 409, cho đến khi lượt dùng kết thúc |
