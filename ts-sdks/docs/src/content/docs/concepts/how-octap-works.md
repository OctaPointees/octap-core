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
| Your website, with `@octap/browser-sdk` | Voucher records, on-chain and in its database |
| The look of your loyalty experience | Sponsoring the customer's transaction fees |

## Who can authorize what

The two SDKs exist because two different parties hold authority.

| Action | Authorized by | How |
| --- | --- | --- |
| Issue points | You | Your API key, from your server |
| Publish or grant a voucher | You | Your API key, from your server |
| Spend points on a voucher, or use one | The customer | Their signature, on their device |
| Spend a customer's points | The customer | Their signature, on their device |

Your API key can never spend a customer's points. It can reserve a spend and return bytes, but only the customer's zkLogin signature completes it.

## Where the truth lives

- **Confirmed points are on Sui.** OctaP's balance is a projection of what the chain confirmed.
- **A voucher's terms and each customer's voucher are on Sui.** Nobody can change the terms after publishing, and only the customer can mark their voucher used.
- **Commands and the catalog are in OctaP's database.** That is where idempotency keys, stock, drafts and serial codes live.

That split is why so much of the SDK reports `PENDING` first. See [Points lifecycle](/concepts/points-lifecycle/).

## Key terms

| Term | Meaning |
| --- | --- |
| Organization | One merchant. Every API key and all its data belong to exactly one. |
| Member | A customer enrolled in your organization, called `organizationEndUserId` in requests. |
| End user | One customer across OctaP, with one `suiAddress`. |
| Program | Your organization's on-chain points program, including its earn rate. |
| Voucher | A promise you define and publish, in whatever form suits your business. |
| Ownership | One customer's voucher, with a `serialCode` for looking it up. |

## Customer sign-in

Customers sign in with Google, and zkLogin turns that into a Sui address they control without a wallet. The Browser SDK handles all of it through OctaP's public routes.

All merchants currently share one OctaP Google client ID. So a token a customer showed to another merchant also verifies on your backend: treat it as proof of who the customer is, not as consent to anything. Moving to per-merchant clients later would change customers' wallets.
