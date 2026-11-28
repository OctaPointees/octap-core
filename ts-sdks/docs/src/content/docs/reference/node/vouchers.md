---
title: Vouchers
description: Node SDK methods for the voucher catalog, claims, grants, customer-signed use and refund policy.
---

## createVoucher

`POST /v1/rewards/vouchers` · Scope: `write`

```ts
createVoucher(request: CreateVoucherRequest, options?): Promise<VoucherDto>
```

| Parameter | Type | Description |
| --- | --- | --- |
| `code` | `string` | **Required.** Unique in your organization. |
| `title` | `string` | **Required.** |
| `discountType` | `'PERCENTAGE' \| 'FIXED_AMOUNT' \| 'FREE_ITEM'` | **Required** unless `terms` is set. |
| `terms` | `object` | Your own description of the promise. Published on-chain, so no personal data. |
| `description` | `string` | |
| `pointsCost` | `number` | Defaults to 0, a free voucher. |
| `discountValue` | `string` | |
| `totalSupply` | `number \| null` | |
| `perMemberLimit` | `number \| null` | How many of this voucher one member may hold. Used and expired ones count, even when refunded later; cancelled ones (including an unused one that was refunded) don't. `null` is no limit. A claim or grant past it is a 409. |
| `startsAt` | `string \| null` | ISO date-time with seconds and timezone |
| `expiresAt` | `string \| null` | ISO date-time with seconds and timezone |
| `validForDays` | `number \| null` | Each customer's voucher is usable this many days from when it is issued, capped by `expiresAt`. 1–3650; `null` means every voucher expires at `expiresAt`. Fixed once publishing starts. |
| `metadata` | `object` | |
| `status` | `'DRAFT' \| 'ACTIVE' \| 'PAUSED'` | Defaults to `ACTIVE`, which publishes the terms on-chain first. If your organization requires approval, `ACTIVE` puts the voucher in `PENDING_APPROVAL` until an Owner approves it in the console. Resuming a published voucher needs no approval. |
| `campaignId` | `string` | A campaign of yours, not `ENDED` or `ARCHIVED`, that the voucher joins. Set on create only. |

A claim's or member voucher's `expiresAt` is that customer's own deadline. `VoucherDto` adds `id`, `organizationId`, `claimedCount`, `publishStatus`, `suiTermsId`, `refundPolicy`, `approval`, `batchId`, `campaignId`, `createdBy`, `activatedBy`, `activatedAt`, `createdAt` and `updatedAt`. `createdBy` is who created the voucher and `activatedBy` who took it live (whoever activated it, or the Owner who approved it), each `{ type: 'USER' | 'API_CREDENTIAL', id }`, or `null` when not recorded (vouchers created before this was kept) or once that user or key is deleted; `activatedAt` is when publishing started. `approval` is the latest approval request, `null` if there never was one. `submittedBy` is `null` once that user or key is deleted. Fields: `id` (the submission an Owner approves or rejects), `status` (`PENDING`, `APPROVED`, `REJECTED` or `WITHDRAWN`), `submittedBy` (`{ type: 'USER' | 'API_CREDENTIAL', id }`), `submittedAt`, `reviewedById`, `reviewedAt`, `reason` (why it was rejected) and `snapshot` (the terms as submitted, which is what approving publishes; `null` for submissions made before it was kept).

## updateVoucher

Takes any fields from `createVoucher`. Once publishing starts, everything in the terms is fixed; metadata, supply, `perMemberLimit` and status are not. `validForDays` is part of the terms. [Guide](/guides/manage-vouchers/#edit-a-voucher)

`PATCH /v1/rewards/vouchers/:id` · Scope: `write`

```ts
updateVoucher(voucherId: string, request: UpdateVoucherRequest, options?): Promise<VoucherDto>
```

## listVouchers

`GET /v1/rewards/vouchers` · Scope: `read`

```ts
listVouchers(options?): Promise<VoucherDto[]>
```

## getVoucher

`GET /v1/rewards/vouchers/:id` · Scope: `read`

```ts
getVoucher(voucherId: string, options?): Promise<VoucherDto>
```

## createVouchers

`POST /v1/rewards/voucher-batches` · Scope: `write`

```ts
createVouchers(items: VoucherBatchItem[], batchOptions?: { dryRun?: boolean; name?: string; campaignId?: string }, options?): Promise<CreateVoucherBatchResponse>
```

Creates up to 100 vouchers as one **DRAFT** batch. Nothing goes live until `activateVoucherBatch`. Each item takes `createVoucher`'s fields except `status`; sending `status` makes that item an error. More than 100 items, or none, is a 400 for the whole call.

With `dryRun: true`, every check runs and each item's result is returned, but nothing is written: use it to preview a file. `name` labels the batch, for example the file's name (up to 120 characters, not unique). `campaignId` puts every voucher the batch creates into that campaign; an item can't carry its own.

Each item is handled on its own, and `items[i]` of the response describes `items[i]`. `code` is the key:

| Voucher already holding the `code` | Same values | Other values |
| --- | --- | --- |
| None | `created` | `created` |
| Published, publishing or waiting for approval | `unchanged` | `conflict`: kept as it is |
| A draft of an open batch, or created on its own | `unchanged` | `conflict`: kept as it is |
| `ARCHIVED` (a draft of an archived batch) | `unchanged`, back to `DRAFT` in this batch (`movedToBatch: true`) | `replaced`: now holds the sent values, as a `DRAFT` in this batch |

`error` means the item was not written: `error.code` is `INVALID` (with the `field`) or `DUPLICATE_IN_BATCH` (the same `code` earlier in the request). `conflict` and `replaced` list `differences: [{ field, stored, sent }]`.

Values are compared after normalizing: a field left out is its default, dates compare as instants (`…Z` equals `…+07:00` at the same moment), `"20"` equals `"20.00"`, and object keys can come in any order. So sending the same list again is safe: only new items are created. To offer different terms under a live `code`, use a new `code`.

`batch` is `null` on a dry run, and when no item landed in the batch (all `unchanged`, `conflict` or `error`).

## parseVoucherCsv

No request: it runs in your process.

```ts
parseVoucherCsv(text: string, options?: { utcOffset?: string }): ParsedVoucherCsv
```

Reads a CSV in the Octap voucher template (the file the console imports, `VOUCHER_CSV_TEMPLATE`) into items for `createVouchers`. It makes the console's checks: a row it can't read, that breaks a rule, or that repeats an earlier row's `code` gets a `problem` naming the CSV column, and is left out of `items`. Core still checks every item it receives.

```ts
import { readFile } from 'node:fs/promises';
import { parseVoucherCsv } from '@octap/sdk';

const { items, rows, error } = parseVoucherCsv(await readFile('rewards.csv', 'utf8'));
if (error) throw new Error(error); // empty file, missing column, more than 100 rows
for (const row of rows) if (row.problem) console.warn(`line ${row.line}: ${row.problem}`);
const preview = await client.createVouchers(items, { dryRun: true });
```

- `rows`: every row, with its `line` (the header is line 1), its `code`, and its `item` or its `problem`. `items[i]` is the item of `rows.filter((row) => row.item)[i]`, so a result's `index` leads back to its line.
- Dates: `claims_open_on` starts at 00:00:00 and `claims_close_on` ends at 23:59:59 of that day in `utcOffset` (default `+07:00`). Dates Excel rewrote (`31/12/2027`, `12/31/2027`) are read; one that could be either day and month is refused.
- An empty `code` is made from the title, as the console does (`suggestVoucherCode`).

### Benefit terms (`octap.benefit.v1`)

The console shows a voucher's offer from its `terms`. To make vouchers it shows like its own, write `terms` in this shape (`parseVoucherCsv` does):

| `type` column | `terms.kind` | `discountType` | Other `terms` fields |
| --- | --- | --- | --- |
| `percent_off` | `PERCENT_OFF` | `PERCENTAGE` (`discountValue`: 1–100) | `maxDiscountVnd` |
| `amount_off` | `AMOUNT_OFF` | `FIXED_AMOUNT` (`discountValue`: VND) | |
| `free_item` | `FREE_ITEM` | `FREE_ITEM` | `item` |
| `buy_x_get_y` | `BUY_X_GET_Y` | none | `buyQuantity`, `getQuantity`, `item` |
| `free_shipping` | `FREE_SHIPPING` | none | `maxDiscountVnd` |
| `fixed_price` | `FIXED_PRICE` | none | `priceVnd`, `item` |
| `custom` | `CUSTOM` | none | `benefit` |

Every kind also has `schema: "octap.benefit.v1"`, and may have `minOrderVnd` and `appliesTo`. Amounts are numbers in VND. `terms` is published on-chain at activation and never changes.

## listVoucherBatches

`GET /v1/rewards/voucher-batches` · Scope: `read`

```ts
listVoucherBatches(query?: { includeArchived?: boolean }, options?): Promise<VoucherBatchDto[]>
```

Newest first. Archived batches only with `includeArchived: true`. Each batch has `name`, `source` (`API` or `CONSOLE`), `createdBy`, `archivedAt` and `statusCounts` (for example `{ DRAFT: 98, ACTIVE: 2 }`).

## getVoucherBatch

`GET /v1/rewards/voucher-batches/:batchId` · Scope: `read`

```ts
getVoucherBatch(batchId: string, options?): Promise<VoucherBatchDetailDto>
```

The batch with its vouchers. Another organization's batch is a 404.

## activateVoucherBatch

`POST /v1/rewards/voucher-batches/:batchId/activate` · Scope: `write`

```ts
activateVoucherBatch(batchId: string, options?): Promise<VoucherBatchActionResponse>
```

Activates every draft of the batch, each one with the same checks as activating it on its own, made now. Each voucher's result has its `outcome` and its `status` after the call:

| `outcome` | Meaning |
| --- | --- |
| `publishing` | Its terms are on the way on-chain; it becomes `ACTIVE` once the chain confirms |
| `pendingApproval` | Your organization requires approval: it waits for an Owner in the console |
| `skipped` | Already published or publishing, or waiting for an Owner, so calling this again is safe; `status` says which |
| `failed` | It stays `DRAFT`; `reason` says why (for example less than 24 hours left before `expiresAt`) |

No loyalty program on-chain is a 422; an archived batch is a 409. Publishing runs a few vouchers at a time, so a large batch takes a few minutes to be fully live.

## pauseVoucherBatch

`POST /v1/rewards/voucher-batches/:batchId/pause` · Scope: `write`

```ts
pauseVoucherBatch(batchId: string, options?): Promise<VoucherBatchActionResponse>
```

Pauses every voucher of the batch that is live or still publishing (`outcome: "paused"`): members can't claim them any more, and the vouchers they already hold stay usable. Drafts and vouchers waiting for approval are `skipped`. Use this to stop a campaign: archiving a batch doesn't stop claims. It works on an archived batch too.

## resumeVoucherBatch

`POST /v1/rewards/voucher-batches/:batchId/resume` · Scope: `write`

```ts
resumeVoucherBatch(batchId: string, options?): Promise<VoucherBatchActionResponse>
```

Resumes every paused voucher of the batch that is published (`outcome: "resumed"`). Resuming needs no approval, since the terms on-chain can't change. One that can't be resumed (for example its claims have closed) is `failed`, with a `reason`.

Approving or rejecting a whole batch is the Owner's, in the console only, as for a single voucher.

## archiveVoucherBatch

`POST /v1/rewards/voucher-batches/:batchId/archive` · Scope: `write`

```ts
archiveVoucherBatch(batchId: string, options?): Promise<VoucherBatchActionResponse>
```

For a batch you won't use (a wrong file, a cancelled campaign). It is hidden from `listVoucherBatches` and can no longer be activated. Each of its vouchers that never went live becomes `ARCHIVED` (`outcome: "archived"`; one waiting for approval is withdrawn): it can't be edited, submitted or go live any more. Importing its code again brings it back as a `DRAFT` in the new batch. Its live vouchers stay live (`skipped`): pause the batch to stop claims. There is no un-archive.

## claimVoucher

Reserves a voucher. It stays `RESERVED` until the chain confirms. [Guide](/guides/claim-a-paid-voucher/)

`POST /v1/rewards/vouchers/:id/claim` · Scope: `write`

```ts
claimVoucher(voucherId: string, request: ClaimVoucherRequest, options?): Promise<ClaimVoucherResponse>
```

| Parameter | Type | Description |
| --- | --- | --- |
| `organizationEndUserId` | `string` | **Required.** A UUID. |
| `idempotencyKey` | `string` | **Required.** 1–100 letters, numbers, `:`, `_` or `-`. |

| Returned field | Type | Description |
| --- | --- | --- |
| `voucherOwnershipId` | `string` | Use it with `getVoucherClaim`. |
| `voucherId` | `string` | |
| `organizationEndUserId` | `string` | |
| `serialCode` | `string` | Use it with `prepareVoucherUse` once `AVAILABLE`. |
| `status` | [`VoucherOwnershipStatus`](/reference/status-values/) | |
| `pointsDeducted` | `number` | Zero until the chain confirms. |
| `pointsCost` | `number` | |
| `transactionId` | `string \| null` | The `REDEEM` transaction. Use it to reverse the claim. |
| `digest` | `string \| null` | Present on a claim response while `RESERVED` |
| `transactionBytes` | `string \| null` | Present on a claim response while `RESERVED` |
| `refundPolicy` | `VoucherRefundPolicySnapshot` | Published with the voucher's terms |
| `claimedAt` | `string` | |
| `expiresAt` | `string \| null` | |

## getVoucherClaim

Reads the saved state of a claim. It doesn't return signing bytes or a digest.

`GET /v1/rewards/claims/:id` · Scope: `read`

```ts
getVoucherClaim(ownershipId: string, options?): Promise<ClaimVoucherResponse>
```

## finalizeVoucherClaim

Submits the customer's signature for a claim, on the same route as `finalizePosRedemption`. Your API key isn't what authorizes it.

`POST /v1/credits/redeem/finalize` · Public: the signature authorizes it

```ts
finalizeVoucherClaim(request: { digest: string; signature: string }, options?): Promise<FinalizePosRedemptionResponse>
```

## grantVoucher

Gives a customer a voucher without spending their points. It stays `RESERVED` until the chain records it, and `voucher.granted` reports that. [Guide](/guides/manage-vouchers/#give-a-voucher)

`POST /v1/rewards/vouchers/:id/grant` · Scope: `write`

```ts
grantVoucher(voucherId: string, request: GrantVoucherRequest, options?): Promise<ClaimVoucherResponse>
```

| Parameter | Type | Description |
| --- | --- | --- |
| `organizationEndUserId` | `string` | **Required.** A UUID. |
| `idempotencyKey` | `string` | **Required.** 1–100 letters, numbers, `:`, `_` or `-`. |

## prepareVoucherUse

Asks the customer to use a voucher. It returns bytes for their device to sign and marks nothing used. [Guide](/guides/claim-a-paid-voucher/#4-use-the-voucher)

`POST /v1/rewards/vouchers/use` · Scope: `write`

```ts
prepareVoucherUse(request: PrepareVoucherUseRequest, options?): Promise<PrepareVoucherUseResponse>
```

| Parameter | Type | Description |
| --- | --- | --- |
| `serialCode` | `string` | **Required.** 1–100 letters, numbers, `_` or `-`. |
| `idempotencyKey` | `string` | **Required.** 1–100 letters, numbers, `:`, `_` or `-`. |

Returns `voucherOwnershipId`, `voucherId`, `serialCode`, `status`, `digest`, `transactionBytes`, `voucherTitle`, `discountType` and `discountValue`. `digest` and `transactionBytes` are null once the use has settled.

## finalizeVoucherUse

Submits the customer's signature for a use. In a browser, use `auth.signAndFinalizeVoucherUse`.

`POST /v1/rewards/vouchers/use/finalize` · Public: the signature authorizes it

```ts
finalizeVoucherUse(request: { digest: string; signature: string }, options?): Promise<RedeemVoucherResponse>
```

Returns `voucherOwnershipId`, `voucherId`, `serialCode`, `status`, `redeemedAt`, `voucherTitle`, `discountType`, `discountValue` and `blockchainDigest`.

## listMemberVouchers

`GET /v1/rewards/members/:memberId/vouchers` · Scope: `read`

```ts
listMemberVouchers(memberId: string, options?): Promise<VoucherOwnershipDto[]>
```

## getVoucherRefundPolicy

Reads the policy the next published voucher takes.

`GET /v1/rewards/refund-policy` · Scope: `read`

```ts
getVoucherRefundPolicy(options?): Promise<VoucherRefundPolicyDto>
```

## listVoucherRefundPolicyHistory

Lists policy versions, newest first. The Owner publishes a new version in the console; no API key can. [Settings](/guides/manage-vouchers/#refunds)

`GET /v1/rewards/refund-policy/history` · Scope: `read`

```ts
listVoucherRefundPolicyHistory(query?: { limit?: number; beforeVersion?: number }, options?): Promise<VoucherRefundPolicyDto[]>
```

`limit` is 1–100 and defaults to 50. `beforeVersion` is an exclusive cursor: pass the last version of the previous page.
