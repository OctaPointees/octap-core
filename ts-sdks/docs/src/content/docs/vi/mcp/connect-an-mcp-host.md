---
title: Kết nối MCP host
description: Cho phép trợ lý AI đọc dữ liệu thành viên, voucher, ngân sách và vận hành trên OctaP qua @octap/mcp (stdio hoặc remote HTTP).
---

`@octap/mcp` là một [Model Context Protocol](https://modelcontextprotocol.io) server. Nó giúp trợ lý AI (*MCP host*, như Claude Desktop, Cursor hoặc Antigravity) trả lời các câu hỏi như "số dư của thành viên này là bao nhiêu?" hoặc "có voucher nào đang chờ duyệt không?" bằng cách gọi OctaP Core API thay bạn.

Trang này mô tả `@octap/mcp` được xây dựng từ repository `octap-core` (`ts-sdks/packages/mcp`).

:::caution[Mặc định chỉ đọc (read-only)]
Mọi tool trong `@octap/mcp` chỉ đọc, trừ khi người dùng đăng nhập qua `serve-http` chọn **Also allow it to make changes**. Khi đó cũng chỉ quản lý được voucher, và mỗi thay đổi đều được hiển thị cho người dùng xác nhận trước. Server không bao giờ phát, tiêu hay đảo điểm, không giữ khóa Sui và không chạm trực tiếp vào database.
:::

## Chọn cách kết nối

| Chế độ | Xác thực | Tools | Phù hợp cho |
| --- | --- | --- | --- |
| **Local stdio** (`octap-mcp`) | API key của organization (scope `read`) | 3 tool thành viên | Developer hoặc support chạy trên máy cá nhân với API key |
| **Remote HTTP** (`octap-mcp serve-http`) | Google OAuth qua Console (token 1 giờ) | 13 tool (Developer) hoặc 19 tool (Owner) + prompts | Nhân sự đăng nhập bằng đúng tài khoản & vai trò Console của mình |
| **Nhúng qua code** (`createServer()`) | `http.authInfo` đã xác thực + `resolveMemberId` | Tập tool thu hẹp (vd: số dư & giao dịch) | Chatbot cho khách hàng cuối trong backend của bạn |

---

## Cách A: Chạy local stdio bằng API key

MCP host khởi chạy `octap-mcp` trên máy bạn và giao tiếp qua stdio. Mỗi lần gọi tool tương ứng một REST request qua [`@octap/sdk`](/vi/reference/node/client/) dùng API key của organization.

```text
AI assistant (MCP host) --stdio--> octap-mcp --HTTPS + API key--> OctaP Core API
```

### Chuẩn bị trước khi bắt đầu

- Node 20.3 trở lên trên máy chạy host.
- Một OctaP API key có scope `read`. Xem [API key và scope](/vi/concepts/api-keys-and-scopes/).
- URL của Core API, ví dụ `http://127.0.0.1:3000` khi [chạy trên máy](/vi/get-started/run-locally/).

:::danger[Key đọc được mọi thành viên trong organization]
API key gắn với toàn bộ organization, nên trợ lý có thể tra cứu **bất kỳ** thành viên nào theo ID. Chỉ cấp `octap-mcp` chế độ stdio cho nhân sự nội bộ (Owner, Business Developer, Support), tuyệt đối không dùng chung key này cho chatbot phía khách hàng cuối.
:::

### 1. Lưu API URL và key

Host và server trao đổi JSON-RPC qua `stdout`, nên server không thể hỏi tương tác khi host chạy. Hãy chạy lệnh setup một lần trong terminal bình thường:

```sh
npx -y @octap/mcp setup
```

URL và key được lưu tại `~/.octap/mcp.json` (hoặc `%USERPROFILE%\.octap\mcp.json` trên Windows). Trên macOS/Linux chỉ user hiện tại đọc được file này.

| Lệnh | Tác dụng |
| --- | --- |
| `octap-mcp setup` | Nhập API URL và key rồi lưu vào file cấu hình |
| `octap-mcp setup --path` | In đường dẫn file cấu hình đang dùng |
| `octap-mcp setup --clear` | Xóa file cấu hình; server sẽ từ chối khởi động sau đó |

Biến môi trường `OCTAP_API_URL` và `OCTAP_API_KEY` ghi đè từng giá trị trong file. `OCTAP_MCP_CONFIG_PATH` dùng để đổi vị trí file.

### 2. Thêm server vào MCP host

Thêm cấu hình sau vào file config của host (ví dụ `claude_desktop_config.json`), không cần truyền biến môi trường nếu đã chạy `setup`:

```json
{
  "mcpServers": {
    "octap": {
      "command": "npx",
      "args": ["-y", "@octap/mcp"]
    }
  }
}
```

Nếu chạy từ mã nguồn local, hãy build ở thư mục gốc (`npm install && npm run build`) rồi trỏ `"command": "node"` và `"args": ["<path-to-octap-core>/ts-sdks/packages/mcp/dist/cli.js"]`.

:::caution
Không dùng `npm run` hay `npm start` trong cấu hình host. npm in banner ra `stdout`, làm hỏng luồng JSON-RPC và khiến host ngắt kết nối.
:::

---

## Cách B: Remote HTTP đăng nhập Google Console (`serve-http`)

Thay vì dùng chung API key, nhân sự có thể đăng nhập bằng chính tài khoản Google dùng trên OctaP Console. Core đóng vai trò OAuth 2.1 authorization server (`POST /oauth/register`, `GET /oauth/authorize` với PKCE S256, `POST /oauth/token`, `POST /oauth/revoke`).

Mỗi lần đăng nhập tạo một opaque token có hạn 1 giờ (`octap_mcp_…`), gắn chặt với **1 organization** và **persona** của user tại đó (`BUSINESS_OWNER` hoặc `BUSINESS_DEVELOPER`). Core kiểm tra lại membership trên từng request và từ chối ngay nếu quyền bị thu hồi hoặc đổi vai trò.

```text
MCP host --Streamable HTTP + Bearer token--> octap-mcp serve-http --GET + token--> OctaP Core API
```

### Điều kiện phía Core & Google OAuth

- Core cần cấu hình `MCP_OAUTH_ISSUER_URL` (origin công khai của Core, không kèm path) và `MCP_OAUTH_SIGNING_KEY` (khóa base64 32-byte); nếu thiếu, các route OAuth trả về `503`.
- Origin của Core phải nằm trong danh sách Authorized JavaScript origins của `CONSOLE_GOOGLE_CLIENT_ID`.
- Redis phải đang chạy trên Core (dùng để lưu request đăng nhập, auth code 60 giây và token 1 giờ dưới key SHA-256).

### Khởi chạy HTTP server

```sh
OCTAP_API_URL=https://api.octap.example \
OCTAP_MCP_PUBLIC_URL=https://mcp.octap.example \
OCTAP_MCP_PORT=4100 \
npx -y @octap/mcp serve-http
```

Trỏ MCP host hoặc MCP Inspector tới `<OCTAP_MCP_PUBLIC_URL>/mcp` dưới dạng Streamable HTTP server. Khi nhận `401`, host sẽ tự mở trang đăng nhập Google của Core trên trình duyệt.

Để thử trên máy: chạy Core ở `http://localhost:3000` với `MCP_OAUTH_ISSUER_URL=http://localhost:3000`, chạy `OCTAP_API_URL=http://localhost:3000 npx -y @octap/mcp serve-http`, rồi kết nối MCP Inspector tới `http://localhost:4100/mcp`.

---

## Cách C: Nhúng vào backend cho khách hàng (`createServer()`)

Khi nhúng MCP vào chatbot dành cho khách hàng cuối:

1. Truyền `resolveMemberId(context)` vào `createServer()` để ánh xạ `http.authInfo` đã xác thực sang UUID của thành viên. Khi có `resolveMemberId`, tham số `memberId` bị ẩn khỏi schema gửi cho LLM.
2. Giới hạn `tools` chỉ còn các tool an toàn cho khách hàng (ví dụ `['get_member_balance', 'list_member_transactions']`).
3. Dùng `project` nếu cần lọc/ẩn bớt dữ liệu trước khi trả về cho model.

Không bao giờ dùng MCP session ID hoặc tham số do model truyền vào để xác thực. Tham khảo file mẫu `ts-sdks/packages/mcp/examples/customer-embed.ts` trong repo.

---

## Gọi thử lần đầu

Thử hỏi trợ lý (hoặc chạy `npx @modelcontextprotocol/inspector npx -y @octap/mcp`):

> Số dư điểm của thành viên 3f6c2a9e-8b1d-4c57-9e0a-2d4b6f8c1e73 là bao nhiêu?

Trợ lý sẽ gọi `get_member_balance` và nhận về:

```json
{
  "memberId": "3f6c2a9e-8b1d-4c57-9e0a-2d4b6f8c1e73",
  "confirmedBalance": 120,
  "pendingEarn": 0,
  "pendingRedemption": 0,
  "lifetimeEarned": 120,
  "lifetimeRedeemed": 0,
  "asOfCheckpoint": "48211907",
  "observedAt": "2026-11-18T03:12:45.000Z",
  "stale": false
}
```

Xem danh sách đầy đủ toàn bộ tool và prompt theo từng persona tại [Tool và prompt MCP](/vi/mcp/tools-and-prompts/).

---

## Bảo mật & lọc dữ liệu nhạy cảm

Mọi tool chỉ trả về danh sách trường đã được whitelist: mã `serialCode` của voucher, secret/hash của API key, signing secret và query string của webhook, token lời mời, mã số thuế và số giấy tờ định danh **không bao giờ** đi tới model.

Ở chế độ `serve-http`, `src/personas.ts` quyết định tool/prompt nào được hiển thị theo persona, còn Core kiểm tra lại organization, quy tắc ghi (chỉ route cho phép, cần `mcp:write` và xác nhận) và persona trên từng lần gọi.

---

## Dashboard assistant endpoint trên Core

Core cũng cung cấp endpoint `POST /v1/console/organizations/:organizationId/assistant/messages` (chỉ nhận đăng nhập Google Console; từ chối MCP token). Khi cấu hình đủ (`OPENAI_API_KEY`, `OPENAI_MODEL`, `OCTAP_MCP_PUBLIC_URL` và cấu hình MCP sign-in), Core cấp tạm một MCP token 10 phút theo persona của người dùng, gọi OpenAI Responses API với `mcp` tool, stream kết quả qua SSE (`text`, `tool`, `tool_error`, `refusal`, `done`/`error`), giới hạn tối đa 12 lần gọi tool mỗi lượt và thu hồi token ngay khi kết thúc.

---

## Xử lý sự cố

| Hiện tượng | Nguyên nhân | Cách khắc phục |
| --- | --- | --- |
| `OCTAP_API_KEY is required` hoặc `OCTAP_API_URL is required` | Chưa có file cấu hình và chưa đặt env var (chế độ stdio). | Chạy `npx -y @octap/mcp setup`. |
| `OCTAP_API_URL must use HTTP or HTTPS` | URL không phải dạng `http://` hoặc `https://` đầy đủ. | Chạy lại `setup` với URL hợp lệ. |
| `Core denied this read…` (401 hoặc 403) | API key sai/bị thu hồi/thiếu scope `read`, hoặc OAuth token hết hạn (1 giờ) / bị tạm ngưng quyền. | Cập nhật API key hợp lệ, hoặc đăng nhập lại qua OAuth. |
| `No matching member or resource was found in the configured organization.` | ID không tồn tại **hoặc thuộc organization khác**. Core trả cùng mã 404 để tránh dò dữ liệu chéo tenant. | Kiểm tra lại ID và đúng organization đang kết nối. |
| `Rate limited; do not retry this call in this turn.` | Đã vượt ngưỡng giới hạn request (429). | Chờ một phút rồi thử lại. |
| `Core did not publish OAuth metadata (status 503)` | Core chưa cấu hình `MCP_OAUTH_ISSUER_URL` hoặc `MCP_OAUTH_SIGNING_KEY`. | Cấu hình đủ 2 biến trên Core và khởi động lại. |
| `403 {"error":"invalid_host"}` ở `serve-http` | Header `Host` của request không khớp `OCTAP_MCP_PUBLIC_URL`. | Đặt `OCTAP_MCP_PUBLIC_URL` đúng với origin công khai client đang gọi. |
| Host ngắt kết nối ngay khi bật stdio | Có output thừa in ra `stdout` (thường do dùng `npm run`). | Chạy trực tiếp bằng `npx -y @octap/mcp` hoặc `node .../dist/cli.js`. |

Để gỡ quyền truy cập stdio trên máy, chạy `octap-mcp setup --clear` (và thu hồi API key trên OctaP Console nếu nghi ngờ lộ key).

## Tính năng chưa phát hành

- Các tool ghi/thay đổi dữ liệu (phát điểm, tặng/duyệt voucher, sửa cấu hình).
- OAuth refresh token (phiên remote hết hạn sau 1 giờ và cần đăng nhập lại).
- Nhật ký audit cho từng lần gọi MCP tool theo người dùng.
- Máy chủ MCP remote chính thức (`mcp.octap.com`) và giao diện chat trên Console.

Để tích hợp trực tiếp OctaP vào sản phẩm của bạn, hãy dùng [Node SDK](/vi/get-started/backend-quickstart/) và [Browser SDK](/vi/get-started/frontend-quickstart/).
