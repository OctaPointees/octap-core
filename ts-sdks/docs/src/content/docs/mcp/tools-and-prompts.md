---
title: MCP tools and prompts
description: Read-only tools, persona permissions, inputs, outputs and built-in prompts exposed by @octap/mcp.
---

All tools in `@octap/mcp` are strictly read-only. Every tool declares an output schema and returns structured content alongside JSON text.

## Mode & persona availability

- **Local stdio (`octap-mcp` with API key):** exposes the 3 member tools (`get_member_balance`, `list_member_transactions`, `list_member_vouchers`).
- **Remote HTTP (`octap-mcp serve-http` with Console Google OAuth):** exposes tools and prompts based on the signed-in user's persona in the bound organization.

| Persona | Tools | Prompts |
| --- | --- | --- |
| **Business Developer** | 13 tools (`get_connection`, `get_organization`, `find_member`, `get_member`, `get_member_balance`, `list_member_transactions`, `list_member_vouchers`, `list_vouchers`, `get_voucher`, `list_voucher_batches`, `get_voucher_batch`, `get_budget`, `list_api_keys`) | `find_customer`, `check_member_transactions`, `summarize_member`, `review_api_keys` |
| **Business Owner** | All 13 Developer tools + 6 Owner tools (`get_refund_policy`, `get_refund_policy_history`, `list_webhook_endpoints`, `list_webhook_deliveries`, `list_staff`, `list_invitations`) | All 4 Developer prompts + 4 Owner prompts (`review_pending_vouchers`, `check_budget`, `check_webhooks`, `review_console_access`) |

Core re-checks the organization, read-only `GET` restriction, and persona on every HTTP request.

---

## Member tools (stdio & `serve-http`)

### `get_member_balance`

| Input | Type | Notes |
| --- | --- | --- |
| `memberId` | UUID | Required (omitted automatically when `resolveMemberId` is configured) |

Returns `confirmedBalance`, `pendingEarn`, `pendingRedemption`, `lifetimeEarned`, `lifetimeRedeemed`, `asOfCheckpoint`, `observedAt` and `stale`. Matches [`getBalance`](/reference/node/credits/).

### `list_member_transactions`

| Input | Type | Notes |
| --- | --- | --- |
| `memberId` | UUID | Required (omitted when `resolveMemberId` is set) |
| `limit` | 1–50 | Default `20` |
| `cursor` | string | Optional `nextCursor` from previous page |

Returns `{ transactions, nextCursor }`, newest first. Each transaction includes `transactionId`, `type`, `status`, `pointsAmount` (`null` until settled), `estimatedPoints`, `purchaseAmount`, `blockchainDigest`, `createdAt` and `updatedAt`. See [status values](/reference/status-values/).

### `list_member_vouchers`

| Input | Type | Notes |
| --- | --- | --- |
| `memberId` | UUID | Required (omitted when `resolveMemberId` is set) |
| `limit` | 1–50 | Default `20` |
| `cursor` | string | Optional `nextCursor` from previous page |

Returns the member's vouchers with `ownershipId`, `voucherId`, `title`, `status`, `claimedAt`, `redeemedAt` and `expiresAt`. **Serial codes are never returned.**

---

## Console tools (`serve-http` only)

### Session & organization

| Tool | Persona | Inputs | What it returns |
| --- | --- | --- | --- |
| `get_connection` | Developer, Owner | None | Bound organization (`id`, `name`, `slug`), persona, signed-in user, token `expiresAt` |
| `get_organization` | Developer, Owner | None | Display & legal name, `organizationType`, `status`, `voucherApprovalRequired`, `logoUrl` (no tax/identity numbers) |
| `get_budget` | Developer, Owner | None | Remaining points budget, share used, low-budget warning, lowest shard, recent top-ups |
| `list_api_keys` | Developer, Owner | None | Key `name`, `keyPrefix`, `scopes`, `status`, `createdAt`, `lastUsedAt` (never raw keys or hashes) |

### Members

| Tool | Persona | Inputs | What it returns |
| --- | --- | --- | --- |
| `find_member` | Developer, Owner | `query` (name/email/phone), `posId`, `status`, `limit` (1–50), `cursor` | Paged member profiles (`items`, `nextCursor`) and member UUIDs for other member tools |
| `get_member` | Developer, Owner | `memberId` (UUID), optional flags to include recent transactions and vouchers | Member profile, status, points balance, and optional transactions/vouchers (serial codes omitted) |

### Vouchers & batches

| Tool | Persona | Inputs | What it returns |
| --- | --- | --- | --- |
| `list_vouchers` | Developer, Owner | Optional `status` (e.g. `PENDING_APPROVAL`, `DRAFT`, `ACTIVE`), search query, `limit`, `cursor` | Reward catalog with status, points cost, discount, supply left and dates |
| `get_voucher` | Developer, Owner | `voucherId` (UUID) | Full voucher details, latest approval request, and rejection reason if rejected |
| `list_voucher_batches` | Developer, Owner | Optional `limit`, `cursor` | Imported voucher batches with status counts |
| `get_voucher_batch` | Developer, Owner | `batchId` (UUID) | Batch details and its vouchers |

### Owner-only governance, webhooks & staff

| Tool | Persona | Inputs | What it returns |
| --- | --- | --- | --- |
| `get_refund_policy` | Owner | None | Current policy (`version`, `allowUnused`, `allowExpired`, `allowRedeemed`, `restockUnused`, `refundWindowDays`, `reason`) |
| `get_refund_policy_history` | Owner | Optional `beforeVersion`, `limit` | Earlier policy versions, newest first, with `nextBeforeVersion` |
| `list_webhook_endpoints` | Owner | None | Configured endpoints (`id`, `url` without query string, `description`, `status`, `createdAt`; signing secrets omitted) |
| `list_webhook_deliveries` | Owner | Optional `status` (`PENDING`, `DELIVERED`, `DEAD_LETTER`), `endpointId`, `limit`, `cursor` | Recent deliveries with attempts, `lastResponseStatus`, `lastError`, and `nextAttemptAt` |
| `list_staff` | Owner | None | Staff with Console access (`name`, `email`, `persona`, `status`: active or suspended) |
| `list_invitations` | Owner | None | Console invitations (`email`, `role`, `status`, `expiresAt`; invitation tokens/links omitted) |

---

## Built-in prompts (`serve-http`)

MCP hosts can surface these prompts directly to users:

| Prompt | Persona | Arguments | Purpose |
| --- | --- | --- | --- |
| `find_customer` | Developer, Owner | `who` (name, email, phone or POS id) | Look up a customer and summarize their status |
| `summarize_member` | Developer, Owner | `memberId` | Summarize balance, recent points activity and vouchers held |
| `check_member_transactions` | Developer, Owner | `memberId` | Find pending or failed points transactions for debugging |
| `review_api_keys` | Developer, Owner | None | Spot unused, stale, or write-scoped API keys |
| `review_pending_vouchers` | Owner | None | List vouchers awaiting Owner approval and key checks before approving |
| `check_budget` | Owner | None | Check remaining points budget and whether a top-up is needed |
| `check_webhooks` | Owner | None | Group failed/retrying webhook deliveries by endpoint and identify likely causes |
| `review_console_access` | Owner | None | Review active/suspended staff and pending invitations |
