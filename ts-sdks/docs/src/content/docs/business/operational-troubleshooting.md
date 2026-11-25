---
title: Operational troubleshooting
description: Diagnose and recover from permission errors, insufficient points, pending/failed operations, expiry, duplicate redemption and refund questions.
---

Use this guide to diagnose common operational issues from the Business Console or POS without inspecting the database or exposing secrets. For backend code or API integration details, follow the linked developer references.

---

## Permission and access errors

| Symptom | Likely cause | What to check & recovery |
| --- | --- | --- |
| Cannot approve vouchers, edit refund policy, invite staff, or submit `UPDATE_IDENTITY` (403) | Signed in as **Business Developer**, not **Business Owner** | Ask an Owner to perform the action or update your role on `/organizations/:slug/team`. |
| Signed-in user suddenly gets 401/403 across all Console routes | Staff membership was **suspended** or role changed | Ask an Owner to verify your status in **Team** and re-sign in. |
| "Organization not found" or missing member/voucher | Looking at the wrong organization slug or tenant | Confirm the `:slug` in the URL matches the customer's merchant organization. |

---

## Points balance and issuance budget issues

| Symptom | Likely cause | What to check & recovery |
| --- | --- | --- |
| Customer says they have enough points, but claim/redeem says **insufficient points** | Points are still in **`pendingEarn`** (awaiting Sui confirmation) or locked in **`pendingRedemption`** | Open **Members** (`/organizations/:slug/members`) and compare `confirmedBalance` vs `pendingEarn` and `pendingRedemption`. Wait for pending earns to confirm, or wait for an abandoned checkout/claim reservation to expire. |
| POS / backend earn requests fail with budget error | Organization **issuance budget** is exhausted | Check the budget card on the **Dashboard**. An Owner must request/apply a budget top-up before new points can be issued. |
| Low-budget warning appears on Dashboard | Remaining budget crossed the organization's warning threshold | Plan a budget top-up early so peak checkout earns are not interrupted. See [Issuance budget](/concepts/issuance-budget/). |

---

## Pending, failed, or unknown operations

| Symptom | Likely cause | What to check & recovery |
| --- | --- | --- |
| Earn or reversal stays **`PENDING`** longer than a few seconds | Background worker or Sui RPC lag | Wait briefly and refresh the member's transaction list. Do **not** issue a duplicate earn with a new `idempotencyKey`. |
| Paid voucher claim or POS redemption stays **`PENDING`** | Customer has not signed on their device yet, or closed the browser | Ask the customer to complete the signature prompt on their device. If abandoned, the reservation times out and releases held points automatically. |
| Operation shows **`FAILED`** or **`UNKNOWN`** | Chain execution failed or outcome could not be confirmed before expiry | Escalate to your developer team with the `transactionId` / `requestId` (never share API keys). Developers should follow [Idempotency and recovery](/concepts/idempotency-and-recovery/). |

---

## Voucher claim, expiry, and cashier serial issues

| Symptom | Likely cause | What to check & recovery |
| --- | --- | --- |
| Customer cannot see or claim a voucher | Voucher is still in **`DRAFT`**, **`PENDING_APPROVAL`**, **`REJECTED`**, or **`ARCHIVED`** | Check `/organizations/:slug/vouchers`. Ensure an Owner approved it (if approval is required) and the batch is activated (`ACTIVE`). |
| Claim rejected: out of stock or limit reached | `SOLD_OUT` supply or customer hit the voucher's **per-member limit** | Check remaining supply and per-member limit on the voucher detail panel. An Owner/Developer can increase supply to reopen a sold-out reward if intended. |
| Cashier redemption fails: **Expired** | Past the voucher's end date or `validForDays` window from the issue/claim date | Verify the voucher's `expiresAt` in **Members**; do not accept expired serials unless your organization handles them under a refund policy. |
| Cashier redemption fails: **`ALREADY_REDEEMED`** (duplicate use) | Customer already used this `serialCode` (or is presenting a screenshot of a used voucher) | Check the voucher's `redeemedAt` status in **Members** and decline duplicate redemption. |
| Customer says "I claimed it, why didn't my discount apply?" | Paid claim only **issues** the voucher; **using** the serial at checkout is a separate customer-signed step | Guide the customer to present their `serialCode` to the cashier and complete the voucher-use confirmation. |

---

## Refunds and policy terms

When a customer requests a points refund for a voucher:

1. Check the organization's active **Refund Policy** (and **Refund Policy History** if the voucher was claimed under an earlier version) at `/organizations/:slug/settings`:
   - `allowUnused`: whether an `ACTIVE` (unredeemed) voucher can be refunded.
   - `allowExpired`: whether an `EXPIRED` voucher can be refunded.
   - `allowRedeemed`: whether a `REDEEMED` voucher can be refunded.
   - `restockUnused`: whether refunding an unused voucher returns its slot to catalog supply.
   - `refundWindowDays`: maximum number of days after claim/issue during which a refund is permitted.
2. Verify the voucher's current status (`ACTIVE`, `REDEEMED`, `EXPIRED`) and dates in **Members** before escalating or processing the refund.

## When escalating to developers or support

Include only safe identifiers:
- Organization slug / ID
- Member UUID (`organizationEndUserId`) or POS ID
- `transactionId`, `ownershipId`, or `X-Request-Id`

In your Console, you can also check:
- **Sandbox vs Live API key:** confirm test traffic is not using a sandbox key when expecting live on-chain points (and use webhook test events when validating endpoints).
- **Per-key request logs:** filter by `requestId` or status code (`4xx`/`5xx`) to see which API call failed.
- **Audit log (Owner) & on-chain reconciliation:** verify who performed an administrative write (role changes, voucher approvals, policy updates) and compare projected balances against on-chain evidence.

Never paste raw API keys, webhook signing secrets, invitation links, or customer tax/identity documents into chat tickets or documentation.
