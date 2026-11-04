---
title: Claim voucher trả phí
description: Đổi điểm của khách hàng lấy voucher, giữa server của bạn và thiết bị của họ.
---

Luồng này dùng cả hai SDK. Server của bạn giữ chỗ voucher, khách hàng ký trên thiết bị của họ, và chain trừ điểm.

| Bước | Ở đâu | Điều gì xảy ra |
| --- | --- | --- |
| 1. Giữ chỗ | Server của bạn | Giữ điểm và một đơn vị tồn kho. Voucher ở trạng thái `RESERVED`. |
| 2. Ký và finalize | Trình duyệt của khách hàng | Khách hàng ký, và giao dịch được gửi lên chain. |
| 3. Xác nhận | Server của bạn | Đọc claim cho đến khi nó là `AVAILABLE`. |
| 4. Redeem | Server của bạn | Dùng serial khi thanh toán. Không có điểm nào thay đổi ở bước này. |

## 1. Giữ chỗ trên server

Xác minh khách hàng trước, và tạo key từ thứ ổn định. Thử lại với key này sẽ tiếp tục đúng claim đó.

```ts title="POST /api/claim"
const { memberId, active } = await client.verifyCustomer(idToken);
if (!memberId || !active) throw new Forbidden();

const claim = await client.claimVoucher(voucherId, {
  organizationEndUserId: memberId,
  idempotencyKey: `claim-${memberId}-${voucherId}`,
});

return claim;
```

Claim trả phí trả về `status: 'RESERVED'`, `pointsDeducted: 0`, `digest` và `transactionBytes`. Voucher miễn phí trả về `AVAILABLE` ngay, nên không có gì để ký.

## 2. Ký và finalize trên trình duyệt

```ts
const claim = await (await fetch('/api/claim', { method: 'POST', headers })).json();

if (claim.status === 'RESERVED') {
  try {
    await auth.signAndFinalize(claim);
  } catch (error) {
    if (error.code === 'outcome-unknown') {
      // Có thể đã thất bại, hoặc vẫn sẽ lên chain. Hãy đọc claim, đừng bắt đầu claim mới.
    }
  }
}
```

Private key dùng để ký không bao giờ rời khỏi thiết bị. `signAndFinalize` không bao giờ tự thử lại, và từ chối mọi thứ ngoài claim `RESERVED` có bytes.

Nếu cần chữ ký mà chưa muốn gửi đi, hãy dùng `auth.signTransaction(claim.transactionBytes)`, rồi gọi `finalizeVoucherClaim` trên server với chữ ký và digest.

## 3. Xác nhận trên server

```ts
const claim = await client.getVoucherClaim(ownershipId);

switch (claim.status) {
  case 'AVAILABLE': // Đã sở hữu. Hiển thị voucher.
  case 'RESERVED':  // Chưa sở hữu. Hiển thị đang chờ, và đọc lại sau.
  case 'CANCELLED': // Thất bại hoặc bị bỏ dở. Điểm và tồn kho đã được giải phóng. Lúc này dùng key mới là an toàn.
}
```

Hãy kiểm tra `organizationEndUserId` của claim đúng là thành viên đã xác minh trước khi trả về. API key của bạn đọc được claim của mọi thành viên, và claim chứa mã serial có thể redeem.

## 4. Redeem khi thanh toán

Redeem là dùng voucher. Điểm đã bị trừ từ trước, nên không có điểm nào thay đổi.

```ts
const redeemed = await client.redeemVoucher({
  serialCode: claim.serialCode,
  receiptReference: order.id,
});
```

Mỗi serial chỉ redeem được một lần. Lệnh này không có idempotency key, nên sau khi chưa rõ kết quả, hãy đọc trạng thái trước khi thử lại.

## Quy tắc cho giao diện của bạn

Dù giao diện thế nào, hãy tuân theo các quy tắc sau:

- Voucher `RESERVED` chưa thuộc về khách hàng. Hiển thị là đang chờ cho đến khi `AVAILABLE`.
- Không bao giờ tự thử lại khi chưa rõ kết quả.
- Tiếp tục với cùng key. Chỉ dùng key mới sau `CANCELLED`.
- Claim chưa ký sẽ được giải phóng sau 30 phút, trả lại điểm và tồn kho.

Mỗi thành viên chỉ giữ được một claim chưa hủy cho mỗi voucher.
