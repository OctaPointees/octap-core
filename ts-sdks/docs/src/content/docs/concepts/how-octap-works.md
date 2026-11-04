---
title: How OctaP works
description: What OctaP runs, what you run, and who can authorize what.
---

OctaP runs whatever changes the points and vouchers it holds. You choose the commercial values, and you own your orders, your money and your promises to customers.

## Who runs what

| You run | OctaP runs |
| --- | --- |
| Your checkout, orders and payments | The Core API and its workers |
| Your backend, with `@octap/sdk` | Points on the Sui blockchain |
| Your website, with `@octap/browser-sdk` | Voucher records and serial codes |
| The look of your loyalty experience | Sponsoring the customer's transaction fees |

## Who can authorize what

The two SDKs exist because two different parties hold authority.

| Action | Authorized by | How |
| --- | --- | --- |
| Issue points | You | Your API key, from your server |
| Create or redeem a voucher serial | You | Your API key, from your server |
| Spend a customer's points | The customer | Their signature, on their device |

Your API key can never spend a customer's points. It can reserve a spend and return bytes, but only the customer's zkLogin signature completes it.

## Where the truth lives

- **Confirmed points are on Sui.** OctaP's balance is a projection of what the chain confirmed.
- **Commands and vouchers are in OctaP's database.** That is where idempotency keys, voucher catalogs and serial codes live.

That split is why so much of the SDK reports `PENDING` first. See [Points lifecycle](/concepts/points-lifecycle/).

## Key terms

| Term | Meaning |
| --- | --- |
| Organization | One merchant. Every API key and all its data belong to exactly one. |
| Member | A customer enrolled in your organization, called `organizationEndUserId` in requests. |
| End user | One customer across OctaP, with one `suiAddress`. |
| Program | Your organization's on-chain points program, including its earn rate. |
| Voucher | A reward you define. |
| Ownership | One customer's claim on a voucher, with a single-use `serialCode`. |

## Customer sign-in

Customers sign in with Google, and zkLogin turns that into a Sui address they control without a wallet. The Browser SDK handles all of it through OctaP's public routes.

All merchants currently share one OctaP Google client ID. So a token a customer showed to another merchant also verifies on your backend: treat it as proof of who the customer is, not as consent to anything. Moving to per-merchant clients later would change customers' wallets.
