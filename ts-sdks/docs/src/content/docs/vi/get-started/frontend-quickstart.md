---
title: Quickstart cho frontend
description: Thêm đăng nhập Google vào website và chứng minh khách hàng với backend của bạn.
---

Thêm đăng nhập giống như cách bạn thêm Firebase Auth. Bạn không phải xử lý OAuth nonce, ephemeral key, zero-knowledge proof hay Enoki.

Bạn cần URL API của OctaP, ID tổ chức của bạn và Google client ID của OctaP, trong đó đã thêm origin của website bạn.

## 1. Tạo đối tượng auth

```ts title="auth.ts"
import { createOctapAuth } from '@octap/browser-sdk';

export const auth = createOctapAuth({
  apiBaseUrl: 'https://your-octap-api.example',
  organizationId: 'your-organization-id',
  googleClientId: 'octap-google-client-id',
});
```

Các giá trị này đều không phải bí mật. API key vẫn nằm trên server của bạn.

## 2. Hiển thị nút đăng nhập

```html
<div id="sign-in"></div>
```

```ts
await auth.renderGoogleButton(document.getElementById('sign-in'), {
  onError: (error) => showMessage(error.message),
});
```

Khi đăng nhập, khách hàng cũng được đăng ký vào tổ chức của bạn. Nút không hiển thị khi khách đang đăng nhập, và xuất hiện lại khi họ đăng xuất hoặc phiên hết hạn.

## 3. Phản ứng theo khách hàng đã đăng nhập

```ts
auth.onAuthStateChanged((user) => {
  if (user) {
    // { endUserId, memberId, suiAddress }
    showAccount(user.memberId);
  } else {
    showSignedOut();
  }
});
```

Listener cũng chạy một lần khi tải trang, sau khi tải lại trang khôi phục phiên. `auth.currentUser` cho cùng giá trị đó vào bất kỳ lúc nào.

## 4. Gọi backend của bạn

Gửi token của khách hàng tới backend, và [xác minh ở đó](/vi/guides/verify-a-customer/). Đừng bao giờ tin một member ID do frontend tự gửi lên.

```ts
const response = await fetch('/api/balance', {
  method: 'POST',
  headers: { authorization: `Bearer ${await auth.getIdToken()}` },
});
```

Các lệnh gọi về số dư, lịch sử và voucher cần API key của bạn, nên chúng chạy trên backend qua `@octap/sdk`. Browser SDK không thực hiện các lệnh này.

## 5. Đăng xuất

```ts
await auth.signOut();
```

## Bước tiếp theo

- [Claim voucher trả phí](/vi/guides/claim-a-paid-voucher/), nơi khách hàng ký trên chính thiết bị này
- [Tham chiếu OctapAuth](/vi/reference/browser/octap-auth/), gồm nơi lưu phiên và rủi ro đi kèm
