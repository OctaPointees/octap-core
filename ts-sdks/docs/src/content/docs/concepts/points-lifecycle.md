---
title: Points lifecycle
description: How purchases become points, and what pending and confirmed mean.
---

Sui is the authority on confirmed points, and a chain transaction takes time. So OctaP accepts your command first, then reports the result when the chain answers.

## Earning

1. **You send a purchase amount.** OctaP calculates `floor(purchaseAmount × earnBps ÷ 10000)`, where `earnBps` is your program's rate in basis points.
2. **The estimate is held.** The transaction is `PENDING` and the estimate is in `pendingEarn`. The customer can't spend it.
3. **The chain answers.** On confirmation, the actual amount moves into `confirmedBalance`. On failure, the hold is released and nothing is credited.

For example, 100,000 at 100 basis points (1%) reserves 1,000 estimated points and confirms 1,000 points. The estimate can differ from the result, so only trust confirmed amounts.

A purchase that rounds down to zero points is refused with a 400, because the chain would abort it. Each earn also has to fit your [issuance budget](/concepts/issuance-budget/).

## What each field means

| Where | Field | While pending | After confirmation |
| --- | --- | --- | --- |
| Earn response | `estimatedPoints` | The estimate | `null` |
| Earn response | `pointsEarned` | `null` | Actual points |
| History | `pointsAmount` | `null` for an earn | Actual points |
| History | `estimatedPoints` | The estimate | `null` |
| Balance | `pendingEarn` | Includes the estimate | Released |
| Balance | `confirmedBalance` | Excludes it | Includes actual points |

A balance with `stale: true` has something pending, so part of it can still change.

## Spending

Spending works the other way around: a hold first, then the customer's signature.

1. **You reserve.** Your server reserves the points, which moves them into `pendingRedemption`, and gets transaction bytes.
2. **The customer signs.** Their device signs the bytes.
3. **It is finalized.** The signed transaction goes to the chain. Only the chain's verdict debits `confirmedBalance`.

A hold that is never signed is released after 30 minutes. The release runs on the next balance read or reservation for that member, and a worker also sweeps abandoned voucher claims. A hold with a submitted transaction is never released by age alone.

## Expiry

Points expire according to your program's policy. OctaP removes expired points from the balance when it next reads or spends them, even before the chain reports it.

## Reversals

A reversal undoes a confirmed earn or redemption in the ledger straight away, and a chain-confirmed original is also mirrored on-chain afterwards. Reversing an earn that was already spent can leave a negative balance: that is the member's debt, and it blocks further spending until it is covered. `balanceWentNegative` tells you when this happens.
