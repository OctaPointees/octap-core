---
title: Issuance budget
description: The limit on how many points your program can issue, and how to raise it.
---

Your issuance budget is the total number of points your program may still issue. It lives on the chain, and every earn subtracts the points it credits. It stops a bug or a wrong amount from issuing points without limit.

A budget is a number of points, not money. A top-up raises that number, and no payment moves. The value of the points you issue remains your commitment to your customers.

## How it works

1. **It is set once.** An OctaP System Admin sets the initial budget when your program is provisioned.
2. **Earns use it.** A confirmed earn subtracts its points. Reversing an earn whose points weren't spent returns them.
3. **It doesn't reset.** The budget covers the life of the program, not a month.

Points that are redeemed or expire don't return to the budget.

## Check what remains

```ts
const budget = await client.getIssuanceBudget();
// budget.remaining, budget.initialBudget, budget.shards, budget.recentTopUps
```

This needs the `read` scope. It reads the chain, so earns still in flight aren't subtracted yet. A 503 means the chain couldn't be read, so try again.

Portal users read the same data from these routes:

| Who | Route |
| --- | --- |
| Members of the organization | `GET /v1/console/organizations/:id/budget` |
| System Admins | `GET /v1/platform/organizations/:id/budget` |

## Request a top-up

An organization Owner proposes an amount and a reason:

```http
POST /v1/console/organizations/:id/change-requests
Authorization: Bearer <Google ID token>

{ "requestType": "BUDGET_TOP_UP", "payload": { "amount": 50000 }, "reason": "Campaign in December" }
```

An OctaP System Admin then approves or rejects it at `POST /v1/platform/change-requests/:id/approve` or `/reject`, with a required reason. The approver and reason are stored. After approval, a worker applies the top-up on the chain, and it appears in `recentTopUps`.

| `recentTopUps[].status` | Meaning |
| --- | --- |
| `PENDING`, `PROCESSING` | Waiting for the chain |
| `SUBMITTED` | Applied |
| `FAILED` | Not applied, because the program no longer exists |
| `UNKNOWN` | It may have been applied. An operator has to check, and it is never retried automatically. |

This API isn't part of the SDK, because proposing and approving use portal sessions rather than API keys.

## When the budget runs out

- **Before accepting:** an earn that the budget can't cover gets a 422, and nothing is reserved.
- **After accepting:** earns in flight aren't counted in that check, so an accepted earn can still fail. You then get the [`credits.earn.failed`](/reference/webhook-events/#creditsearnfailed) webhook with `failureCode: 'BUDGET_EXHAUSTED'`.

To retry a failed earn after a top-up, use a [new idempotency key](/guides/earn-and-reverse-points/#when-an-earn-fails).

A program with several budget shards splits its budget evenly, and a shard never borrows from another. So an earn can be refused while `remaining` is above zero. `shards` shows each amount.
