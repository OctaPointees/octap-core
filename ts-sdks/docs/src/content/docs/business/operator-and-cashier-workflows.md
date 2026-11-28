---
title: Operator and cashier workflows
description: Role-oriented walkthroughs for sign-in, onboarding, member lookup, issuing points, voucher management, customer claim and cashier serial redemption.
---

These walkthroughs describe the supported workflows across the OctaP Business Console and partner customer/cashier flows. Each workflow lists the **actor**, **prerequisites**, **steps**, **expected outcome**, and **recovery action**.

:::note[Visual walkthroughs]
Annotated portal screenshots will be added in a follow-up update once the new organization-scoped frontend is deployed.
:::

---

## 1. Sign in, onboard, and select an organization

- **Actor:** Business Owner or Business Developer
- **Prerequisites:** A Google account. For an existing organization, an Owner must have invited your email.
- **Steps:**
  1. Open the Business Console (`/`) and sign in with Google.
  2. On `/organizations`, pick an existing organization—or choose **Create organization** (`/onboarding`) if you are setting up a new merchant.
  3. If you were invited by email, open the invitation link or accept the pending invitation for your account.
- **Expected outcome:** You land on `/organizations/:slug`, showing the organization workspace scoped to your role (`BUSINESS_OWNER` or `BUSINESS_DEVELOPER`).
- **Recovery:** If you see no organizations or get an access error, confirm you signed in with the exact Google email that received the invitation, or ask an Owner to check **Team**.

---

## 2. Invite and manage staff (Owner)

- **Actor:** Business Owner
- **Prerequisites:** Signed in as Owner on `/organizations/:slug`.
- **Steps:**
  1. Open **Team** (`/organizations/:slug/team`).
  2. Click **Invite**, enter the staff member's email, and choose their role (`Business Developer` or `Business Owner`).
  3. Share or send the invitation, and track its status (`pending`, `accepted`, `revoked`, `expired`).
- **Expected outcome:** Once accepted, the teammate appears in the active staff list and can open the organization's Console workspace.
- **Recovery:** If an invitation expired or was sent to the wrong address, revoke it and create a new invitation.

---

## 3. Look up a member, balance, and history

- **Actor:** Business Owner, Business Developer, or Support
- **Prerequisites:** Customer is enrolled in your organization.
- **Steps:**
  1. Open **Members** (`/organizations/:slug/members`).
  2. Search by name, email, phone number, or your POS/external member ID.
  3. Select the member to open their detail panel: review **confirmed balance**, **pending earn / pending redemption**, **recent transactions**, and **owned vouchers** (serial codes are masked/omitted in staff views).
- **Expected outcome:** You can verify whether points are confirmed or still pending without inspecting the database.
- **Recovery:** If a customer is missing, verify they enrolled under the current organization (members are strictly isolated per organization).

---

## 4. Issue or reverse points (POS / Backend)

- **Actor:** Merchant backend or POS integration (monitored by Owner / Developer)
- **Prerequisites:** Active API key with write scope, sufficient **issuance budget**, and enrolled `memberId`.
- **Steps:**
  1. Your backend submits an earn (or reversal) request with a stable `idempotencyKey`.
  2. OctaP records the command and submits it to Sui via the background worker.
  3. Staff can verify the result in **Members** (transaction moves from `PENDING` to `CONFIRMED`) and monitor remaining points on the **Dashboard** budget card.
- **Expected outcome:** The member's `confirmedBalance` increases (or decreases on reversal) once Sui confirms, and the issuance budget updates accordingly.
- **Recovery:** If an earn stays `PENDING` or fails, do **not** generate a new `idempotencyKey`; inspect the operation/budget status and see [Operational troubleshooting](/business/operational-troubleshooting/).

---

## 5. Create, approve, and activate vouchers & batches

- **Actor:** Business Developer (create/import) and Business Owner (approve/activate when approval is enabled)
- **Prerequisites:** Organization workspace access on `/organizations/:slug/vouchers`.
- **Steps:**
  1. On **Vouchers** (`/organizations/:slug/vouchers`) or **Imports** (`/organizations/:slug/vouchers/imports`), create a single voucher or import a CSV/XLSX batch. New batches start in **`DRAFT`**.
  2. Review the draft vouchers on `/organizations/:slug/vouchers/imports/:batchId`.
  3. If your organization requires Owner approval, submit the voucher/batch so it enters **`PENDING_APPROVAL`**; an Owner reviews and approves (or rejects with a reason).
  4. Activate the batch/voucher so it becomes **`ACTIVE`** and publishes on-chain.
- **Expected outcome:** Customers can view and claim `ACTIVE` vouchers while supply and dates allow.
- **Recovery:** If a voucher is `REJECTED`, read the rejection reason on the voucher panel, update the draft, and resubmit.

---

## 6. Customer paid voucher claim (Customer device)

- **Actor:** End customer (on your website or the reference partner app)
- **Prerequisites:** Customer signed in via Google/Enoki zkLogin (`@octap/browser-sdk`), voucher is `ACTIVE`, and customer's `confirmedBalance` covers the points cost.
- **Steps:**
  1. Your backend reserves the claim and returns unsigned transaction bytes to the customer's browser.
  2. The customer signs the transaction on their device (zkLogin) and submits finalization.
  3. Wait for chain confirmation: the ownership record starts as `PENDING` and moves to `ACTIVE` with a single-use `serialCode`.
- **Expected outcome:** Points are deducted, stock decreases, and the customer holds an `ACTIVE` voucher with a `serialCode`.
- **Recovery:** Claiming a paid voucher only **issues** it to the customer—it does **not** redeem it at checkout. If the customer closed the tab before signing, the reservation expires automatically and held points are released.

---

## 7. Cashier single-use serial redemption (Separate action)

- **Actor:** Cashier (at POS) + Customer (on their device)
- **Prerequisites:** Customer presents an `ACTIVE` voucher `serialCode` (claimed in Step 6 or granted by the merchant).
- **Steps:**
  1. Cashier enters or scans the customer's `serialCode` in the POS / partner cashier screen.
  2. The backend validates that the voucher belongs to the organization, is `ACTIVE`, and has not expired.
  3. The customer signs the voucher-use transaction on their device (or completes the customer-signed confirmation flow) so the voucher is marked `REDEEMED` on-chain.
- **Expected outcome:** The voucher transitions to `REDEEMED` and the `serialCode` can never be used again.
- **Recovery:** If the cashier sees `ALREADY_REDEEMED` or `EXPIRED`, do not apply the discount; check the customer's voucher status in **Members**.

---

## 8. Organization settings, legal identity & refund policy (Owner)

- **Actor:** Business Owner
- **Prerequisites:** Signed in as Owner on `/organizations/:slug/settings`.
- **Steps:**
  1. Edit display details (such as display name or logo) directly in **Settings**.
  2. To change registered legal details (legal name, tax/identity details), submit an **`UPDATE_IDENTITY`** request—platform administrators must approve it before it takes effect.
  3. To change the base earn rate, submit an **`UPDATE_EARN_RATE`** request with the new `earnBps` (0–10000) and a reason. Platform administrators must approve it; the new rate applies to every earn from the moment it reaches the chain.
  4. Under **Refund Policy**, configure `allowUnused`, `allowExpired`, `allowRedeemed`, `restockUnused`, and `refundWindowDays`, provide a reason, and publish a new version.
- **Expected outcome:** Display settings update immediately; legal and earn-rate changes await admin approval; refund policy creates a new versioned record without overwriting history.
- **Recovery:** Use **Refund Policy History** to audit previous rules if a customer disputes a refund eligibility decision.
