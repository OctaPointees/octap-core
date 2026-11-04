---
title: Xác minh khách hàng
description: Kiểm tra trên backend xem request từ website thực sự thuộc về ai.
---

Website gửi token của khách hàng, và backend của bạn kiểm tra nó, giống `verifyIdToken` trong Firebase Admin. Hãy làm việc này trước khi thao tác thay khách hàng, và đừng bao giờ tin member ID do frontend gửi lên.

## Trên website của bạn

```ts
const response = await fetch('/api/balance', {
  method: 'POST',
  headers: { authorization: `Bearer ${await auth.getIdToken()}` },
});
```

## Trên server của bạn

```ts
const idToken = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
const { memberId, active, suiAddress } = await client.verifyCustomer(idToken);

if (!memberId) {
  // Đăng nhập Google hợp lệ nhưng chưa đăng ký vào tổ chức của bạn.
} else if (!active) {
  // Đã đăng ký nhưng bị chặn: các thao tác phần thưởng cho thành viên này sẽ bị từ chối.
} else {
  const balance = await client.getBalance(memberId);
}
```

Lệnh gọi cần scope `read` và không ghi gì. Token không hợp lệ hoặc hết hạn sẽ ném `OctaApiError` với status 401.

## Việc kiểm tra chứng minh điều gì

Nó chứng minh khách hàng là ai, không chứng minh sự đồng ý. Tất cả merchant dùng chung một Google client ID, nên token mà khách hàng đã đưa cho merchant khác cũng xác minh được ở đây.

Hãy dùng nó để quyết định hiển thị dữ liệu của ai và thao tác trên tài khoản nào. Mọi việc tiêu điểm vẫn cần chữ ký của khách hàng, và SDK buộc điều đó.

## Token hết hạn

Token của Google có hiệu lực khoảng một giờ. Khi `getIdToken` phát hiện token đã hết hạn, khách hàng bị đăng xuất, listener `onAuthStateChanged` nhận `null`, và nút đăng nhập xuất hiện lại.
