---
title: Roles and business concepts
description: Organizations, staff roles, customer memberships, points states, rewards, voucher batches and ownership states explained in business language.
---

This guide explains how OctaP models your business, your staff, your customers, and your points and vouchers—without needing to read database tables or API payloads.

## Organizations, staff roles, and customer memberships

| Concept | Who it is | How they sign in | What they can do |
| --- | --- | --- | --- |
| **Organization** | One merchant / partner brand | — | Owns one points program, budget, catalog, member directory, and API keys. |
| **Business Owner** | Merchant owner or operations lead | Google account on the Business Console | Full organization access: team invitations, refund policy, voucher approvals, webhooks, legal identity change requests, plus all Developer actions. |
| **Business Developer** | Engineer or integration operator | Google account on the Business Console | Manage API keys, members, draft vouchers/batches, and view budgets/organization status. Cannot approve vouchers (when approval is required), edit refund policies, or manage staff. |
| **Member (Customer)** | An end customer enrolled in your organization | Google account via your website (`@octap/browser-sdk` / zkLogin) | Holds a Sui loyalty wallet, earns points, claims rewards, and signs voucher redemptions on their own device. |

:::note
Staff accounts and customer memberships are separate. A staff member's Console Google login grants access to the merchant portal, whereas a customer's sign-in creates or accesses their on-chain loyalty account.
:::

## Points states and issuance budget

When customers earn or spend points, OctaP separates **pending** activity from **confirmed** on-chain state:

- **Confirmed balance:** Points settled on Sui and ready to spend on rewards or checkout discounts.
- **Pending earn:** Points issued by your POS or backend that are waiting for blockchain confirmation. They cannot be spent yet.
- **Pending redemption:** Points temporarily held while a customer completes or settles a checkout redemption or paid voucher claim.
- **Issuance budget:** Your organization's available pool of points that can be issued to customers. If the budget runs out, new point-earning requests are rejected until a top-up is approved/applied. A low-budget warning appears when remaining points drop below your configured threshold.

## Rewards, batches, and customer vouchers

OctaP separates **the reward definition** (what your business offers) from **the customer's voucher** (one issued coupon owned by a customer):

### Batch lifecycle (bulk imports)

- **`DRAFT`:** Imported or created in bulk, not visible to customers yet. Can be edited or discarded.
- **`ACTIVE`:** Published and available for claiming/granting (subject to individual voucher approval if enabled).
- **`ARCHIVED`:** Retired batch; no new claims are allowed.

### Voucher catalog states

- **`DRAFT`:** Saved in a draft batch, not yet submitted or published.
- **`PENDING_APPROVAL`:** Submitted by a Business Developer when the organization requires Owner approval before going live.
- **`ACTIVE`:** Live on-chain and in the catalog; eligible customers can claim or receive it while stock and dates allow.
- **`REJECTED`:** Declined by a Business Owner with a rejection reason; must be revised before resubmitting.
- **`SOLD_OUT`:** Remaining supply reached zero (can be reopened if stock is increased).
- **`ARCHIVED`:** Disabled and no longer claimable.

### Customer voucher ownership states

- **`PENDING`:** Customer started a paid claim (or grant is confirming on-chain); wait for confirmation before issuing or using the serial.
- **`ACTIVE`:** Confirmed in the customer's account with a single-use `serialCode`, ready to be redeemed at checkout.
- **`REDEEMED`:** Already used once; the serial cannot be redeemed again.
- **`EXPIRED`:** Past the voucher's expiry date (or `validForDays` window from claim/issue date).
- **`REFUNDED`:** Returned under the organization's refund policy.

## Feature availability

- **Supported today:** Google Console sign-in and onboarding, organization selection, Business Owner & Business Developer roles, member directory & balance/history lookup, reward & batch management (including optional Owner approval), paid voucher claims, single-use serial redemption, refund policies, legal identity change requests, sandbox API keys & webhook test events, per-key API request logs, Owner durable audit logs, and on-chain balance reconciliation / evidence views.
- **Demo / reference only:** The partner storefront/cashier screens in the reference app demonstrate customer claim and cashier serial redemption flows; your production POS/website integrates those flows via the [Node SDK](/get-started/backend-quickstart/) and [Browser SDK](/get-started/frontend-quickstart/).
- **Not shipped yet:** Automated license billing/plans, write actions in MCP AI assistants, and a separate centralized `auth.octap.com` portal (sign-in currently happens directly on the Business Console).
