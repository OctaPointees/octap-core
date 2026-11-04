---
title: Cài đặt
description: Các package của OctaP SDK, công dụng của từng package và cách dùng hiện nay.
---

## Các package

| Package | Chạy ở | Dùng để |
| --- | --- | --- |
| `@octap/sdk` | Server Node của bạn | Điểm, voucher, webhook và xác minh khách hàng. Giữ API key của bạn. |
| `@octap/browser-sdk` | Website của bạn | Đăng nhập và ký giao dịch của khách hàng. Không giữ thông tin xác thực của merchant. |
| `@octap/contracts` | Bất kỳ đâu | Chỉ gồm kiểu TypeScript. `@octap/sdk` đã re-export những kiểu bạn cần. |

Đừng bao giờ import `@octap/sdk` vào code chạy trên trình duyệt, vì việc đó sẽ làm lộ API key của bạn.

## Cài đặt package

:::caution[Chưa có trên npm]
Các package đang ở chế độ private và chưa được publish, nên lệnh bên dưới chưa chạy được. `@octap/browser-sdk` đang ở phiên bản 0.1.0, `@octap/sdk` ở 0.0.0, và cả hai vẫn có thể thay đổi.
:::

Sau khi được publish, bạn sẽ cài như sau:

```sh
# Trên server của bạn
npm install @octap/sdk

# Trên website của bạn
npm install @octap/browser-sdk
```

## Cách dùng hiện nay

Làm việc ngay trong repository `octap-core`, nơi thư mục gốc quản lý mọi package dưới dạng npm workspace.

```sh
git clone https://github.com/OctaPointees/octap-core.git
cd octap-core
npm ci
npm run build
```

Code trong repository đó có thể import `@octap/sdk` và `@octap/browser-sdk` theo tên. Trang [Chạy thử trên máy](/vi/get-started/run-locally/) có các ví dụ làm đúng như vậy.

## Yêu cầu

- **Node SDK:** runtime có `fetch` toàn cục. Bản thân repository yêu cầu Node `>=24.15 <25`.
- **Browser SDK:** trình duyệt hiện đại có thể tải được script đăng nhập của Google.
- **Từ OctaP:** một API key, ID tổ chức của bạn, và để đăng nhập thì cần Google client ID dùng chung, trong đó đã thêm origin của website bạn.
