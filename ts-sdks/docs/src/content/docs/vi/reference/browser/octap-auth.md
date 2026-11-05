---
title: OctapAuth
description: API đăng nhập, phiên và ký giao dịch của Browser SDK.
---

## createOctapAuth

```ts
import { createOctapAuth } from '@octap/browser-sdk';

const auth = createOctapAuth(options);
```

`new OctapAuth(options)` có tác dụng tương tự.

| Tùy chọn | Kiểu | Mô tả |
| --- | --- | --- |
| `apiBaseUrl` | `string` | **Bắt buộc.** URL của Core API. |
| `organizationId` | `string` | **Bắt buộc.** Khách hàng đăng ký vào tổ chức này. |
| `googleClientId` | `string` | **Bắt buộc.** Client ID do OctaP cung cấp. |
| `persistence` | `'session' \| 'memory'` | Nơi lưu phiên. Mặc định là `'session'`. |
| `timeoutMs` | `number` | Timeout của request. Mặc định 35 giây. Finalize chờ 90 giây. |
| `fetch` | `typeof fetch` | Thay thế `fetch` toàn cục. |

Phiên đã lưu gắn với ba giá trị bắt buộc này, nên đổi bất kỳ giá trị nào cũng sẽ không khôi phục được phiên.

## currentUser

Khách hàng đang đăng nhập, có ngay sau khi tải lại trang. `null` khi phiên hết hạn.

```ts
auth.currentUser: OctapUser | null
```

| Field | Kiểu | Mô tả |
| --- | --- | --- |
| `endUserId` | `string` | |
| `memberId` | `string` | `organizationEndUserId` của họ trong tổ chức của bạn |
| `suiAddress` | `string` | |

## onAuthStateChanged

Gọi listener với khách hàng hiện tại ngay sau khi đăng ký, rồi mỗi khi có thay đổi. Trả về hàm để hủy đăng ký.

```ts
auth.onAuthStateChanged(listener: (user: OctapUser | null) => void): () => void
```

## renderGoogleButton

Hiển thị nút của Google, và xử lý key, nonce, đăng ký và proof khi khách hàng dùng nút. Nút không hiển thị khi khách đang đăng nhập.

```ts
auth.renderGoogleButton(element: HTMLElement, options?: RenderOptions): Promise<void>
```

| Tùy chọn | Kiểu | Mô tả |
| --- | --- | --- |
| `onError` | `(error: OctapAuthError) => void` | Lỗi đăng nhập, xảy ra bên ngoài mọi lệnh gọi bạn có thể await |
| `button` | `object` | Truyền cho nút của Google, như `theme`, `size`, `text` hoặc `shape` |

## getIdToken

Trả về id_token để backend [xác minh](/vi/guides/verify-a-customer/). Nếu đã hết hạn, khách hàng bị đăng xuất và lệnh này ném `token-expired`.

```ts
auth.getIdToken(): Promise<string>
```

## signAndFinalize

Ký một claim `RESERVED` và finalize. Voucher chưa thuộc về khách hàng cho đến khi lệnh này hoàn tất. Không bao giờ tự thử lại.

```ts
auth.signAndFinalize(claim: SignableClaim, options?: RequestOptions): Promise<FinalizedClaim>
```

`claim` cần `status`, `digest` và `transactionBytes`, do `claimVoucher` trên backend trả về. `options` nhận `signal` và `timeoutMs`.

Mọi lỗi trừ giới hạn tần suất đều trở thành `outcome-unknown`, vì response lỗi không chứng minh được giao dịch không lên chain. Giới hạn tần suất là lỗi duy nhất chứng minh chưa có gì được thực hiện, nên nó xuất hiện dưới dạng `api-error` với status 429.


## signAndFinalizeVoucherUse

Ký lượt dùng voucher của khách hàng và finalize. Hãy cho khách hàng thấy họ đang dùng gì trước: chữ ký này là thứ duy nhất đánh dấu được voucher của họ là đã dùng.

```ts
auth.signAndFinalizeVoucherUse(use: SignableVoucherUse, options?: RequestOptions): Promise<FinalizedVoucherUse>
```

`use` là kết quả `prepareVoucherUse` trả về trên server của bạn. Giống `signAndFinalize`, nó không bao giờ tự thử lại, và báo `outcome-unknown` khi chưa rõ kết quả. Nó thất bại với `invalid-claim` khi không có gì để ký.

## signTransaction

Trả về chữ ký zkLogin trên transaction bytes dạng base64, và không gửi gì. Từ chối bytes có người gửi không phải khách hàng đang đăng nhập.

```ts
auth.signTransaction(transactionBytes: string): Promise<string>
```

## signOut

Kết thúc phiên và bỏ mọi lần đăng nhập đang chạy. Nút xuất hiện lại.

```ts
auth.signOut(): Promise<void>
```

## Bảo mật phiên

Phiên giữ ephemeral signing key, proof và id_token cho đến `maxEpoch` hoặc khi đăng xuất.

| `persistence` | Còn sau khi tải lại | Rủi ro |
| --- | --- | --- |
| `'session'` | Có, trong tab này | Mọi script trên trang của bạn đều đọc được `sessionStorage` |
| `'memory'` | Không, tải lại sẽ đăng xuất khách hàng | Ít bị lộ hơn, key chỉ nằm trong bộ nhớ |

Lỗi XSS trên trang dùng `'session'` cho phép kẻ tấn công ký thay khách hàng cho đến khi phiên hết hạn. Hãy dùng Content Security Policy chặt chẽ, và tránh script bên thứ ba trên các trang này. Private key không bao giờ được gửi đi: chỉ phần public của nó tới OctaP.
