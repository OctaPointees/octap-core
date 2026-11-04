---
title: Chạy thử trên máy
description: Chạy demo voucher trên máy của bạn, rồi thử đăng nhập thật trên Sui Testnet.
---

Có hai ví dụ trong `octap-core` dùng các method public của SDK. Chạy cả hai từ thư mục gốc của repository sau khi [thiết lập workspace](/vi/get-started/installation/).

## Demo voucher

Demo này chạy một lần claim trả phí đầy đủ với API thật và database dùng một lần. Bạn cần Docker. Enoki, Sui và chữ ký của khách hàng đều là mock, nên demo chứng minh luồng SDK, chứ không phải giao dịch Testnet thật hay đăng nhập Google thật.

```sh
npm run demo:sdk:local
```

Demo đọc số dư, claim voucher, chuyển giao bước ký, finalize và redeem serial, rồi kiểm tra trạng thái đã lưu. Đọc `scripts/sdk-voucher-demo.mjs` để xem phần backend của luồng này.

Để chạy cùng luồng với API của riêng bạn, đặt các biến sau trong shell. Demo dừng ở bước khách hàng ký, vì chỉ khách hàng mới ký được.

```sh
OCTAP_API_URL=… OCTAP_API_KEY=… OCTAP_DEMO_MEMBER_ID=… OCTAP_DEMO_VOUCHER_ID=… OCTAP_DEMO_RUN_ID=… \
  npm run demo:sdk
```

## Đăng nhập thật trên Testnet

`ts-sdks/examples/browser-auth` là một trang không dùng framework, cùng một server nhỏ đóng vai backend của bạn. Dùng nó để kiểm tra claim trả phí với tài khoản Google thật. Test mock không chứng minh được điều này. Đây chỉ là công cụ chạy local, đừng bao giờ deploy.

1. Chạy API, worker và indexer của Core với `ENOKI_API_KEY` đã đặt và `SUI_NETWORK=testnet`.
2. Chuẩn bị một tổ chức đang hoạt động và đã provision, một API key có scope `read` và `write`, và một voucher trả phí đang hoạt động.
3. Đăng ký Google client ID của bạn trong Enoki portal, và thêm `http://localhost:4001` vào authorized JavaScript origins.
4. Khởi động ví dụ:

   ```sh
   npm run build
   OCTAP_API_KEY=… OCTAP_ORGANIZATION_ID=… GOOGLE_CLIENT_ID=… OCTAP_VOUCHER_ID=… \
     node ts-sdks/examples/browser-auth/server.mjs
   ```

5. Mở `http://localhost:4001` và đăng nhập. Trang hiển thị `memberId` và `suiAddress` của bạn. Tải lại trang để kiểm tra phiên được khôi phục.
6. Earn đủ điểm đã xác nhận cho thành viên đó, và chờ lệnh earn được xác nhận.
7. Bấm **Claim voucher**. Trang hiển thị claim `RESERVED`, kết quả finalize, rồi claim ở trạng thái `AVAILABLE`.

Đặt `OCTAP_EXAMPLE_RUN_ID` để bắt đầu một claim mới thay vì tiếp tục claim trước.
