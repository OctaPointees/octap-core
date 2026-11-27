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

Lists a member's transactions, newest first, one page at a time.

`GET /v1/credits/members/:memberId/transactions` · Scope: `read`

```ts
listTransactions(memberId: string, options?: RequestOptions & { limit?: number; cursor?: string }): Promise<LoyaltyTransactionPage>
```

Returns `{ items, nextCursor }`. `limit` is 1–100 and defaults to 25. To read the next page, pass `nextCursor` back as `cursor`; it is `null` on the last page. A `cursor` that is not one of this member's transactions is a 400.

```ts
let cursor: string | undefined;
do {
  const page = await client.listTransactions(memberId, { limit: 100, cursor });
  for (const tx of page.items) handle(tx);
  cursor = page.nextCursor ?? undefined;
} while (cursor);
```

For an unconfirmed earn, `pointsAmount` is `null` and `estimatedPoints` holds the estimate. A failed earn has `null` for both.

## listOrganizationTransactions

Lists your whole organization's transactions, newest first, with each confirmed one's proof on Sui. Link `blockchainDigest` to a Sui explorer to show a customer the public record.

`GET /v1/credits/transactions` · Scope: `read`

```ts
listOrganizationTransactions(query?: OrganizationTransactionQuery, options?): Promise<LoyaltyTransactionPage>
```

| Parameter | Type | Description |
| --- | --- | --- |
| `type` | `LoyaltyTxType` | Only this type, such as `EARN` |
| `status` | `LoyaltyTxStatus` | Only this status, such as `CONFIRMED` |
| `memberId` | `string` | Only this member |
| `limit` | `number` | 1–100 |
| `cursor` | `string` | `nextCursor` from the previous page |

Returns `{ items, nextCursor }`, like `listTransactions`. A confirmed row carries `blockchainDigest` and `confirmedAt`. A cursor stays valid when its row's status changes later.

## getProgram

Reads your program and the earn policy published for it on Sui, beside the rules OctaP applies.

`GET /v1/credits/program` · Scope: `read`

```ts
getProgram(options?): Promise<ProgramEvidence>
```

| Returned field | Type | Description |
| --- | --- | --- |
| `programId` | `string` | |
| `status` | `string` | |
| `earnBps` | `number` | The earn rate OctaP applies, in basis points |
| `expiryMs` | `number` | How long earned points last |
| `policyStatus` | `'MATCH' \| 'MISMATCH' \| 'UNAVAILABLE'` | `MATCH` when the chain's rules are the ones OctaP applies. `UNAVAILABLE` when the chain could not be read. |
| `policy` | `ProgramPolicyEvidence \| null` | The on-chain policy: `version`, `earnBps`, `expiryMs`, `publishedDigest`, `publishedAt`. `null` when `UNAVAILABLE`. |

## getBalanceReconciliation

Compares a member's balance as OctaP records it with what their `CreditAccount` on Sui can spend.

`GET /v1/credits/members/:memberId/reconciliation` · Scope: `read`

```ts
getBalanceReconciliation(memberId: string, options?): Promise<BalanceReconciliation>
```

| Returned field | Type | Description |
| --- | --- | --- |
| `status` | `'MATCH' \| 'PENDING' \| 'MISMATCH' \| 'UNAVAILABLE'` | `PENDING`: something for this member is still on its way to the chain, so ask again shortly. `MISMATCH`: nothing is in flight and the two differ. |
| `creditAccountId` | `string \| null` | `null` before the member's first earn |
| `recordedBalance` | `number` | OctaP's `confirmedBalance` |
| `ledgerBalance` | `number \| null` | What the chain says is spendable; `null` when `UNAVAILABLE` |
| `difference` | `number \| null` | `ledgerBalance - recordedBalance` |
| `checkedAt` | `string` | ISO 8601. The result is cached for up to 30 seconds. |

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
| `orderReference` | `string` | **Required.** Your order id, 1–100 characters, no personal data. |
| `discountAmount` | `number` | **Required.** The discount on that order, in `currency`'s major units. Greater than zero. |
| `currency` | `string` | **Required.** ISO 4217 code, such as `VND`. |

The last three are hashed into the on-chain redemption the customer signs.

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

Returns `reversalTransactionId`, `reversedTransactionId`, `organizationEndUserId`, `pointsAmount`, `newBalance` and `idempotencyKey`. An earn whose points are spent, held by a pending redemption, or expire within 10 minutes can't be reversed: `409`.
