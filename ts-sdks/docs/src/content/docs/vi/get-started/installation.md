---
title: Cài đặt
description: Các package của OctaP SDK, công dụng của từng package và cách cài từ npm.
---

## Các package

| Package | Chạy ở | Dùng để |
| --- | --- | --- |
| `@octap/sdk` | Server Node của bạn | Điểm, voucher, webhook và xác minh khách hàng. Giữ API key của bạn. |
| `@octap/browser-sdk` | Website của bạn | Đăng nhập và ký giao dịch của khách hàng. Không giữ thông tin xác thực của merchant. |
| `@octap/contracts` | Bất kỳ đâu | Chỉ gồm kiểu TypeScript. `@octap/sdk` đã re-export những kiểu bạn cần. |
| `@octap/mcp` | Máy tính của nhân viên | MCP server chỉ đọc, cho phép trợ lý AI tra cứu thành viên. Xem [Kết nối MCP host](/vi/mcp/connect-an-mcp-host/). |

Đừng bao giờ import `@octap/sdk` vào code chạy trên trình duyệt, vì việc đó sẽ làm lộ API key của bạn.

## Cài đặt package

Tất cả package đều public trên npm dưới scope `@octap`. Vì còn trước 1.0, một bản minor vẫn có thể có thay đổi không tương thích.

```sh
# Trên server của bạn
npm install @octap/sdk

# Trên website của bạn
npm install @octap/browser-sdk
```

`@octap/sdk` tự cài kèm `@octap/contracts`. Các package chỉ hỗ trợ ES module.

## Làm việc từ repository

Để sửa SDK, hoặc chạy các ví dụ với thay đổi của chính bạn, hãy dùng repository `octap-core`. Thư mục gốc của nó quản lý mọi package dưới dạng npm workspace:

```sh
git clone https://github.com/OctaPointees/octap-core.git
cd octap-core
npm ci
npm run build
```

Trang [Chạy thử trên máy](/vi/get-started/run-locally/) có các ví dụ làm đúng như vậy.

## Yêu cầu

- **Node SDK:** runtime có `fetch` toàn cục. Bản thân repository yêu cầu Node `>=24.15 <25`.
- **Browser SDK:** trình duyệt hiện đại có thể tải được script đăng nhập của Google.
- **Từ OctaP:** một API key, ID tổ chức của bạn, và để đăng nhập thì cần Google client ID dùng chung, trong đó đã thêm origin của website bạn.
