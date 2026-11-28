---
title: Vai trò và khái niệm nghiệp vụ
description: Giải thích organization, vai trò nhân sự, thành viên khách hàng, trạng thái điểm, voucher, batch và quyền sở hữu bằng ngôn ngữ nghiệp vụ.
---

Tài liệu này giải thích cách OctaP mô hình hóa doanh nghiệp, nhân sự vận hành, khách hàng, điểm và voucher — không cần xem database hay đọc payload API.

## Organization, vai trò nhân sự và thành viên khách hàng

| Khái niệm | Là ai | Cách đăng nhập | Quyền hạn chính |
| --- | --- | --- | --- |
| **Organization** | Một thương hiệu / merchant | — | Sở hữu riêng chương trình điểm, ngân sách phát hành, danh mục voucher, danh sách thành viên và API key. |
| **Business Owner** | Chủ doanh nghiệp hoặc trưởng vận hành | Tài khoản Google trên Business Console | Toàn quyền trên organization: mời/quản lý nhân sự, chính sách hoàn điểm, duyệt voucher, đăng ký và thay đổi webhook endpoint, yêu cầu đổi thông tin pháp lý, cùng toàn bộ quyền của Developer. |
| **Business Developer** | Kỹ sư hoặc nhân sự vận hành tích hợp | Tài khoản Google trên Business Console | Quản lý API key, tra cứu thành viên, tạo bản nháp voucher/batch, xem ngân sách và trạng thái organization. Không duyệt voucher (khi bật chế độ duyệt), không sửa refund policy hoặc quản lý nhân sự. |
| **Member (Khách hàng)** | Khách hàng cuối tham gia chương trình | Tài khoản Google trên website của bạn (`@octap/browser-sdk` / zkLogin) | Có ví Sui loyalty riêng, tích điểm, claim phần thưởng và tự ký xác nhận dùng voucher trên thiết bị của mình. |

:::note
Tài khoản nhân sự Console và thành viên khách hàng là hai khái niệm tách biệt. Nhân sự đăng nhập Google vào cổng quản trị merchant, còn khách hàng đăng nhập trên website/app của bạn để dùng điểm và voucher.
:::

## Trạng thái điểm và ngân sách phát hành

Khi khách hàng tích hoặc tiêu điểm, OctaP tách riêng giao dịch **đang chờ xử lý** và số dư **đã xác nhận on-chain**:

- **Confirmed balance (Số dư khả dụng):** Điểm đã xác nhận trên Sui, khách có thể dùng ngay để đổi voucher hoặc giảm giá khi thanh toán.
- **Pending earn (Điểm chờ cộng):** Điểm POS/backend vừa phát nhưng đang chờ blockchain xác nhận. Chưa thể tiêu ngay.
- **Pending redemption (Điểm đang giữ):** Điểm tạm giữ trong lúc khách hàng hoàn tất giao dịch trừ điểm hoặc claim voucher trả phí.
- **Issuance budget (Ngân sách phát hành):** Tổng lượng điểm còn lại organization được phép phát cho khách. Nếu cạn ngân sách, yêu cầu phát điểm mới sẽ bị từ chối cho tới khi được nạp thêm. Hệ thống sẽ cảnh báo khi ngân sách xuống dưới ngưỡng cài đặt.

## Voucher, batch và trạng thái voucher của khách

OctaP tách **định nghĩa phần thưởng** (chương trình bạn mở bán/tặng) khỏi **voucher cụ thể của khách** (từng mã đã cấp cho một thành viên):

### Vòng đời Batch (nhập hàng loạt)

- **`DRAFT`:** Batch vừa import/tạo nháp, khách hàng chưa nhìn thấy. Có thể chỉnh sửa hoặc hủy.
- **`ACTIVE`:** Đã kích hoạt để phát hành (vẫn tuân theo bước Owner duyệt nếu organization bật duyệt voucher).
- **`ARCHIVED`:** Đã lưu trữ, ngừng phát hành mới.

### Trạng thái voucher trong danh mục

- **`DRAFT`:** Đang nằm trong batch nháp, chưa gửi duyệt/publish.
- **`PENDING_APPROVAL`:** Do Business Developer gửi lên và đang chờ Business Owner phê duyệt.
- **`ACTIVE`:** Đang hoạt động on-chain và trên danh mục; khách có thể claim nếu còn tồn kho và trong hạn.
- **`REJECTED`:** Bị Business Owner từ chối kèm lý do; cần chỉnh sửa trước khi gửi lại.
- **`SOLD_OUT`:** Đã hết số lượng phát hành (có thể mở lại nếu tăng giới hạn).
- **`ARCHIVED`:** Đã ngừng sử dụng, không thể claim thêm.

### Trạng thái voucher khách hàng đang giữ

- **`PENDING`:** Khách vừa bắt đầu claim trả phí (hoặc lệnh tặng đang chờ chain xác nhận); cần chờ xác nhận trước khi dùng mã serial.
- **`ACTIVE`:** Đã xác nhận trong tài khoản khách, có `serialCode` dùng một lần để thu ngân đối soát.
- **`REDEEMED`:** Đã sử dụng xong; không thể dùng lại mã serial này.
- **`EXPIRED`:** Đã quá hạn sử dụng (theo ngày hết hạn hoặc số ngày `validForDays`).
- **`REFUNDED`:** Đã được hoàn theo chính sách hoàn điểm của organization.

## Mức độ sẵn sàng của tính năng

- **Đã hỗ trợ chính thức:** Đăng nhập Google Console & onboarding, chọn organization, phân quyền Owner / Business Developer, tra cứu thành viên & số dư/lịch sử, quản lý voucher & batch (kèm duyệt bởi Owner), claim voucher trả phí, sử dụng mã serial một lần tại quầy, chính sách hoàn điểm, yêu cầu đổi thông tin pháp lý, API key chế độ Sandbox & sự kiện webhook thử nghiệm, nhật ký request theo API key, audit log cho Owner, và đối soát bằng chứng số dư on-chain.
- **Chỉ mang tính minh họa (Demo / Reference):** Các trang demo trên `partner-website` minh họa luồng khách hàng claim và thu ngân nhập serial; hệ thống production của bạn tích hợp các luồng này thông qua [Node SDK](/vi/get-started/backend-quickstart/) và [Browser SDK](/vi/get-started/frontend-quickstart/).
- **Chưa phát hành:** Gói cước & thanh toán tự động, các thao tác ghi dữ liệu qua MCP AI, và cổng đăng nhập tập trung riêng `auth.octap.com` (hiện đăng nhập trực tiếp trên Business Console).
