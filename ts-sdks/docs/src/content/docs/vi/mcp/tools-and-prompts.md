---
title: Tool và prompt MCP
description: Danh sách các tool đọc và ghi, phân quyền theo persona, tham số đầu vào/ra và prompt dựng sẵn của @octap/mcp.
---

Các tool trong `@octap/mcp` chỉ đọc, trừ khi người dùng đã đăng nhập cho phép thay đổi (xem [tool ghi](#tool-ghi-serve-http-chỉ-khi-người-dùng-cho-phép-thay-đổi)). Mỗi tool đều khai báo output schema và trả về dữ liệu có cấu trúc kèm JSON text.

## Phạm vi theo chế độ & persona

- **Local stdio (`octap-mcp` dùng API key):** cung cấp 3 tool thành viên (`get_member_balance`, `list_member_transactions`, `list_member_vouchers`).
- **Remote HTTP (`octap-mcp serve-http` đăng nhập Google Console):** cung cấp tool và prompt tùy theo persona của người dùng trong organization đang kết nối.

| Persona | Tools | Prompts |
| --- | --- | --- |
| **Business Developer** | 15 tool (`get_connection`, `get_organization`, `find_member`, `get_member`, `get_member_balance`, `list_member_transactions`, `list_member_vouchers`, `list_vouchers`, `get_voucher`, `list_voucher_batches`, `get_voucher_batch`, `get_budget`, `list_api_keys`, `list_webhook_endpoints`, `list_webhook_deliveries`) | `find_customer`, `check_member_transactions`, `summarize_member`, `review_api_keys`, `check_webhooks` |
| **Business Owner** | Toàn bộ 15 tool của Developer + 4 tool của Owner (`get_refund_policy`, `get_refund_policy_history`, `list_staff`, `list_invitations`) | Toàn bộ 5 prompt của Developer + 3 prompt của Owner (`review_pending_vouchers`, `check_budget`, `review_console_access`) |

Core luôn kiểm tra lại organization, quy tắc ghi và persona trên mỗi HTTP request.

---

## Nhóm tool thành viên (stdio & `serve-http`)

### `get_member_balance`

| Đầu vào | Kiểu | Ghi chú |
| --- | --- | --- |
| `memberId` | UUID | Bắt buộc (tự động ẩn nếu cấu hình `resolveMemberId`) |

Trả về `confirmedBalance`, `pendingEarn`, `pendingRedemption`, `lifetimeEarned`, `lifetimeRedeemed`, `asOfCheckpoint`, `observedAt` và `stale`. Tương ứng với [`getBalance`](/vi/reference/node/credits/).

### `list_member_transactions`

| Đầu vào | Kiểu | Ghi chú |
| --- | --- | --- |
| `memberId` | UUID | Bắt buộc (ẩn nếu đặt `resolveMemberId`) |
| `limit` | 1–50 | Mặc định `20` |
| `cursor` | string | Truyền `nextCursor` từ trang trước |

Trả về `{ transactions, nextCursor }`, mới nhất trước. Mỗi giao dịch gồm `transactionId`, `type`, `status`, `pointsAmount` (`null` nếu đang chờ xác nhận), `estimatedPoints`, `purchaseAmount`, `blockchainDigest`, `createdAt` và `updatedAt`. Xem [Các giá trị trạng thái](/vi/reference/status-values/).

### `list_member_vouchers`

| Đầu vào | Kiểu | Ghi chú |
| --- | --- | --- |
| `memberId` | UUID | Bắt buộc (ẩn nếu đặt `resolveMemberId`) |
| `limit` | 1–50 | Mặc định `20` |
| `cursor` | string | Truyền `nextCursor` từ trang trước |

Trả về các voucher thành viên đang giữ gồm `ownershipId`, `voucherId`, `title`, `status`, `claimedAt`, `redeemedAt` và `expiresAt`. **Không bao giờ trả về mã serial.**

---

## Nhóm tool Console (chỉ có ở `serve-http`)

### Phiên kết nối & organization

| Tool | Persona | Đầu vào | Dữ liệu trả về |
| --- | --- | --- | --- |
| `get_connection` | Developer, Owner | Không | Organization đang kết nối (`id`, `name`, `slug`), persona, user đăng nhập, thời điểm hết hạn token `expiresAt` |
| `get_organization` | Developer, Owner | Không | Tên hiển thị & tên pháp lý, `organizationType`, `status`, `voucherApprovalRequired`, `logoUrl` (không lộ mã số thuế/giấy tờ) |
| `get_budget` | Developer, Owner | Không | Ngân sách điểm còn lại, tỷ lệ đã dùng, cảnh báo sắp cạn, shard thấp nhất, các lần nạp gần đây |
| `list_api_keys` | Developer, Owner | Không | `name`, `keyPrefix`, `scopes`, `status`, `createdAt`, `lastUsedAt` (không lộ raw key hay hash) |

### Thành viên

| Tool | Persona | Đầu vào | Dữ liệu trả về |
| --- | --- | --- | --- |
| `find_member` | Developer, Owner | `query` (tên/email/SĐT), `posId`, `status`, `limit` (1–50), `cursor` | Danh sách thành viên phân trang (`items`, `nextCursor`) và `memberId` để gọi các tool khác |
| `get_member` | Developer, Owner | `memberId` (UUID), tùy chọn lấy kèm giao dịch & voucher | Hồ sơ thành viên, trạng thái, số dư điểm và tùy chọn giao dịch/voucher (ẩn mã serial) |

### Voucher & batch

| Tool | Persona | Đầu vào | Dữ liệu trả về |
| --- | --- | --- | --- |
| `list_vouchers` | Developer, Owner | Tùy chọn `status` (vd: `PENDING_APPROVAL`, `DRAFT`, `ACTIVE`), từ khóa, `limit`, `cursor` | Danh mục phần thưởng kèm trạng thái, giá điểm, mức giảm, tồn kho và thời hạn |
| `get_voucher` | Developer, Owner | `voucherId` (UUID) | Chi tiết đầy đủ của voucher, yêu cầu duyệt mới nhất và lý do từ chối (nếu có) |
| `list_voucher_batches` | Developer, Owner | Tùy chọn `limit`, `cursor` | Các batch đã import kèm thống kê số lượng theo trạng thái |
| `get_voucher_batch` | Developer, Owner | `batchId` (UUID) | Chi tiết một batch và các voucher bên trong |

### Webhook, quản trị & nhân sự

| Tool | Persona | Đầu vào | Dữ liệu trả về |
| --- | --- | --- | --- |
| `get_refund_policy` | Owner | Không | Chính sách hoàn điểm hiện tại (`version`, `allowUnused`, `allowExpired`, `allowRedeemed`, `restockUnused`, `refundWindowDays`, `reason`) |
| `get_refund_policy_history` | Owner | Tùy chọn `beforeVersion`, `limit` | Các phiên bản chính sách trước đây, mới nhất trước, kèm `nextBeforeVersion` |
| `list_webhook_endpoints` | Developer, Owner | Không | Danh sách endpoint (`id`, `url` đã lược bỏ query string, `description`, `status`, `createdAt`; ẩn signing secret) |
| `list_webhook_deliveries` | Developer, Owner | Tùy chọn `status` (`PENDING`, `DELIVERED`, `DEAD_LETTER`), `endpointId`, `limit`, `cursor` | Các lượt gửi gần đây kèm số lần thử, `lastResponseStatus`, `lastError` và `nextAttemptAt` |
| `list_staff` | Owner | Không | Nhân sự có quyền vào Console (`name`, `email`, `persona`, `status`: active hoặc suspended) |
| `list_invitations` | Owner | Không | Lời mời vào Console (`email`, `role`, `status`, `expiresAt`; ẩn token/link mời) |

## Tool ghi (`serve-http`, chỉ khi người dùng cho phép thay đổi)

Khi host xin scope `mcp:write`, trang đăng nhập của Core hiện ô **Also allow it to make changes** (mặc định không chọn). Chỉ khi người dùng chọn ô này thì các tool dưới đây mới xuất hiện; nếu không, kết nối vẫn chỉ đọc và Core từ chối mọi thao tác ghi.

Mỗi thay đổi gồm hai bước. Tool tương ứng chỉ **chuẩn bị** thay đổi và trả về bản tóm tắt cùng `confirmationId`; chưa có gì thay đổi. **`confirm_change`** thực hiện thay đổi sau khi người dùng đồng ý. Mỗi xác nhận chỉ dùng được một lần, cho đúng request đó, trong 5 phút; gọi lại với cùng id sẽ nhận lại kết quả lần đầu, không thay đổi hai lần. Core kiểm tra lại persona khi ghi và lưu vào audit log dưới tên người dùng.

| Tool | Chuẩn bị | Owner | Developer |
| --- | --- | --- | --- |
| `create_voucher` | Một voucher nháp mới | ✅ | ✅ |
| `update_voucher` | Sửa trường (Developer: chỉ bản nháp) | ✅ | ✅ |
| `submit_voucher` | Gửi bản nháp cho Owner duyệt | — | ✅ |
| `withdraw_voucher` | Rút voucher đang chờ duyệt về nháp | ✅ | ✅ |
| `activate_voucher` | Phát hành bản nháp, hoặc mở lại voucher đang tạm dừng | ✅ | khi Core cho phép |
| `pause_voucher` | Tạm dừng nhận mới | ✅ | — |
| `approve_voucher`, `reject_voucher` | Duyệt hoặc từ chối voucher đang chờ | ✅ | — |
| `confirm_change` | Thực hiện thay đổi đã chuẩn bị | ✅ | ✅ |

---

## Prompt dựng sẵn (`serve-http`)

Các MCP host có thể hiển thị trực tiếp các prompt sau cho người dùng:

| Prompt | Persona | Tham số | Mục đích |
| --- | --- | --- | --- |
| `find_customer` | Developer, Owner | `who` (tên, email, SĐT hoặc POS id) | Tìm khách hàng và tóm tắt trạng thái |
| `summarize_member` | Developer, Owner | `memberId` | Tóm tắt số dư, lịch sử điểm gần đây và voucher đang giữ |
| `check_member_transactions` | Developer, Owner | `memberId` | Tìm các giao dịch điểm đang `PENDING` hoặc lỗi để debug tích hợp |
| `review_api_keys` | Developer, Owner | Không | Phát hiện API key chưa từng dùng, cũ hoặc có quyền ghi |
| `review_pending_vouchers` | Owner | Không | Liệt kê các voucher chờ Owner duyệt và những điểm cần kiểm tra trước khi duyệt |
| `check_budget` | Owner | Không | Kiểm tra ngân sách điểm còn lại và có cần nạp thêm hay không |
| `check_webhooks` | Developer, Owner | Không | Nhóm các webhook delivery lỗi/đang retry theo endpoint và gợi ý nguyên nhân |
| `review_console_access` | Owner | Không | Rà soát danh sách Owner, Business Developer, tài khoản bị tạm ngưng và lời mời đang chờ |
