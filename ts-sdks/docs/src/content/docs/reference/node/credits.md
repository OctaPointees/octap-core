---
title: Identity and credits
description: Node SDK methods for verifying customers, earning, balances and spending points.
---

## verifyCustomer

Checks a customer's id_token. Writes nothing.

`POST /v1/identity/verify` · Scope: `read`

```ts
verifyCustomer(idToken: string, options?): Promise<VerifyCustomerResponse>
```

| Returned field | Type | Description |
| --- | --- | --- |
| `endUserId` | `string \| null` | `null` if this Google account has never signed in to OctaP |
| `suiAddress` | `string` | The customer's address |
| `memberId` | `string \| null` | Their ID in your organization. `null` until they enroll. |
| `active` | `boolean` | True only when reward operations will accept this member |

Throws `OctaApiError` with status 401 for an invalid or expired token.

## earnPoints

Accepts an earn for a purchase. [Guide](/guides/earn-and-reverse-points/)

`POST /v1/credits/earn` · Scope: `write`

```ts
earnPoints(request: EarnPointsRequest, options?): Promise<EarnPointsResponse>
```

| Parameter | Type | Description |
| --- | --- | --- |
| `organizationEndUserId` | `string` | **Required.** The member. |
| `purchaseAmount` | `number` | **Required.** Positive safe integer, in the currency's smallest unit. |
| `idempotencyKey` | `string` | **Required.** Stable across retries. |
| `receiptReference` | `string` | Your reference. |
| `metadata` | `object` | Your data, stored with the transaction. |

| Returned field | Type | Description |
| --- | --- | --- |
| `transactionId` | `string` | |
| `organizationEndUserId` | `string` | |
| `purchaseAmount` | `number \| null` | `null` only for older transactions |
| `estimatedPoints` | `number \| null` | Set while `PENDING` |
| `pointsEarned` | `number \| null` | Actual points, once confirmed |
| `newBalance` | `number` | Confirmed balance, which excludes this earn while it is pending |
| `status` | [`LoyaltyTxStatus`](/reference/status-values/) | |
| `idempotencyKey` | `string` | |

## getBalance

Reads a member's balance.

`GET /v1/credits/members/:memberId/balance` · Scope: `read`

```ts
getBalance(memberId: string, options?): Promise<CreditBalanceSnapshot>
getBalance(programId: string, memberId: string, options?): Promise<BalanceSnapshot>
```

| Returned field | Type | Description |
| --- | --- | --- |
| `organizationEndUserId` | `string` | |
| `confirmedBalance` | `number` | Spendable points |
| `pendingEarn` | `number` | Estimated points on the way |
| `pendingRedemption` | `number` | Points held for a spend |
| `lifetimeEarned` | `number` | |
| `lifetimeRedeemed` | `number` | |
| `asOfCheckpoint` | `string \| null` | Last Sui checkpoint indexed |
| `observedAt` | `string` | When this was read, in ISO 8601 |
| `stale` | `boolean` | True while something is pending |

With a `programId`, the program can be your program's row ID or on-chain ID, and any other value gets a 404. This form returns `BalanceSnapshot`: `confirmed_balance`, `pending_earn` and `pending_redemption` as strings, plus `as_of_checkpoint`, `observed_at` and `stale`.

## getIssuanceBudget

Reads how many more points your program may issue, live from the chain. [Concept](/concepts/issuance-budget/)

`GET /v1/credits/budget` · Scope: `read`

```ts
getIssuanceBudget(options?): Promise<IssuanceBudgetDto>
```

| Returned field | Type | Description |
| --- | --- | --- |
| `organizationId` | `string` | |
| `remaining` | `number` | Points left across all shards. Earns in flight aren't subtracted yet. |
| `initialBudget` | `number` | The figure set at provisioning, before any top-up |
| `capacity` | `number` | `initialBudget` plus every applied top-up |
| `warningThreshold` | `80 \| 95 \| null` | The percentage used that the fullest shard has crossed |
| `shards` | `{ shardId, remaining }[]` | A shard never borrows from another |
| `recentTopUps` | `{ operationId, amount, status, createdAt }[]` | Latest first, at most 20 |
| `observedAt` | `string` | When this was read, in ISO 8601 |

Throws `OctaApiError` with status 404 if you have no active program, and 503 if the chain can't be read.

## listTransactions

Lists a member's transactions.

`GET /v1/credits/members/:memberId/transactions` · Scope: `read`

```ts
listTransactions(memberId: string, options?: RequestOptions & { limit?: number }): Promise<LoyaltyTransactionDto[]>
```

`limit` defaults to 50. For an unconfirmed earn, `pointsAmount` is `null` and `estimatedPoints` holds the estimate. A failed earn has `null` for both.

## reservePosRedemption

Holds a member's points and returns bytes for them to sign. [Guide](/guides/redeem-points-at-checkout/)

`POST /v1/credits/redeem/reserve` · Scope: `write`

```ts
reservePosRedemption(request: ReservePosRedemptionRequest, options?): Promise<ReservePosRedemptionResponse>
```

| Parameter | Type | Description |
| --- | --- | --- |
| `organizationEndUserId` | `string` | **Required.** |
| `pointsAmount` | `number` | **Required.** Greater than zero. |
| `idempotencyKey` | `string` | **Required.** |

| Returned field | Type | Description |
| --- | --- | --- |
| `transactionId` | `string` | |
| `digest` | `string \| null` | `null` only if this key already settled |
| `transactionBytes` | `string \| null` | Base64, for the customer to sign |
| `status` | [`LoyaltyTxStatus`](/reference/status-values/) | |
| `idempotencyKey` | `string` | |

## finalizePosRedemption

Submits the customer's signature. Cancelling doesn't undo a submitted transaction.

`POST /v1/credits/redeem/finalize` · Public: the signature authorizes it

```ts
finalizePosRedemption(request: { digest: string; signature: string }, options?): Promise<FinalizePosRedemptionResponse>
```

Returns `transactionId`, `organizationEndUserId`, `pointsRedeemed`, `newBalance`, `status` and `blockchainDigest`.

## reverseTransaction

Reverses a confirmed `EARN` or `REDEEM`. [Guide](/guides/earn-and-reverse-points/#reverse-a-transaction)

`POST /v1/credits/transactions/:transactionId/reverse` · Scope: `write`

```ts
reverseTransaction(request: ReverseTransactionRequest, options?): Promise<ReverseTransactionResponse>
```

| Parameter | Type | Description |
| --- | --- | --- |
| `transactionId` | `string` | **Required.** The transaction to reverse. |
| `idempotencyKey` | `string` | **Required.** |
| `reason` | `string` | **Required.** |

Returns `reversalTransactionId`, `reversedTransactionId`, `organizationEndUserId`, `pointsAmount`, `newBalance`, `balanceWentNegative` and `idempotencyKey`.
