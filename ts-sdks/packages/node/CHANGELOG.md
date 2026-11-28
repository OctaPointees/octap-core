# Changelog

## Unreleased

### Added

- Campaigns (OCT-340): `earnPoints({ ..., campaignId })` applies an Owner's time-boxed campaign
  multiplier (up to 10x, from the issuance budget); a campaign that isn't `ACTIVE`, is outside its
  dates or has no multiplier is a 422, never an earn at the base rate. `createVouchers(items,
  { campaignId })` puts a batch's vouchers in a campaign. `VoucherDto.campaignId`, and
  `credits.earned` webhooks carry `campaignId` when a campaign boosted the earn. Needs
  `@octap/contracts` with the campaign types.
- `listCampaigns({ live })` and `getCampaign(id)` (`GET /v1/campaigns`, `read` scope): a POS lists
  the campaigns that boost an earn right now, so the cashier can pick one.

## 0.3.0

### Added

- On-chain evidence reads (OCT-334): `listOrganizationTransactions(query)` (the organization's
  points history with each confirmed row's Sui digest, filtered by type, status or member),
  `getProgram()` (the program's on-chain policy compared with the rules OctaP applies) and
  `getBalanceReconciliation(memberId)` (`MATCH` / `PENDING` / `MISMATCH` / `UNAVAILABLE`). All need
  only a `read` key.

## 0.2.0

### Added

- Voucher expiry webhooks (OCT-336): `voucher.expired` (a voucher's claim window closed while it was
  live, paused or sold out; `VoucherLifecycleEventData`) and `voucher.member_expired` (a customer's
  voucher reached its own deadline unused; `VoucherMemberExpiredEventData`). Each arrives once,
  within about a minute of the deadline.
- Voucher batches (OCT-303): `createVouchers(items, { dryRun, name })` creates up to 100 vouchers
  as one DRAFT batch (`dryRun` previews each item's result and writes nothing), then
  `activateVoucherBatch`, `pauseVoucherBatch`, `resumeVoucherBatch` and `archiveVoucherBatch` act
  on the whole batch and report each voucher's outcome. Read them with `listVoucherBatches` and
  `getVoucherBatch`.
- `VoucherDto.batchId`: the batch a voucher was created or re-imported in, `null` otherwise.
- `parseVoucherCsv(text, { utcOffset })` reads a CSV in the Octap voucher template (the file the
  console imports) into items for `createVouchers`, with the console's checks: each bad row is
  reported with its line and column and left out. Also exported: `VOUCHER_CSV_TEMPLATE`,
  `VOUCHER_CSV_TYPES`, `VOUCHER_BENEFIT_SCHEMA` and `suggestVoucherCode`.
- The reference documents the `octap.benefit.v1` shape of `terms` the console reads.
- `VoucherDto.createdBy`, `activatedBy` and `activatedAt` (OCT-324): who created a voucher, who took
  it live (whoever activated it, or the Owner who approved it) and when publishing started. Each is
  `{ type: 'USER' | 'API_CREDENTIAL', id }` or `null` when not recorded.
- `VoucherApprovalDto.id` and `snapshot`: the submission an Owner decides on, and its terms as
  submitted, which is what approving publishes.

### Changed

- `EXPIRED` is now actually written (OCT-336). A voucher past its claim window is `EXPIRED`, not
  `ACTIVE`, and a customer's voucher past its deadline is `EXPIRED`, not `AVAILABLE`, in every read:
  `listVouchers`, `getVoucher`, `listMemberVouchers`, `getClaim` and voucher batches. Pausing or
  resuming an `EXPIRED` voucher is a 409; its supply and metadata stay editable.

- `VoucherStatus` has a new value, `ARCHIVED`: a voucher of an archived batch that never went
  live. `listVouchers` and `getVoucher` can return it. It can't be edited, submitted or claimed;
  importing its code in a new batch brings it back as `DRAFT`. Code that switches on `status`
  should handle it.

### Breaking changes

The `admin` API key scope is gone. Managing webhooks and the voucher refund policy moved to the
console, where only the organization's Owner can do it. These methods are removed, because no API
key can call their routes any more:

| Removed | Do it in the console instead |
| --- | --- |
| `registerWebhookEndpoint` | Webhooks → register an endpoint |
| `disableWebhookEndpoint`, `enableWebhookEndpoint` | Webhooks → disable / enable |
| `rotateWebhookSecret` | Webhooks → rotate the secret |
| `replayWebhookDelivery` | Webhooks → deliveries → replay |
| `setVoucherRefundPolicy` | Refund policy → publish |

### Changed

- `listVoucherRefundPolicyHistory` needs only a `read` key (it needed `admin`).
- `reverseTransaction` can refund an expired or redeemed voucher with a `write` key when the refund
  policy allows it. It used to need `admin`; now the policy is the only gate.
- `VoucherRefundPolicyDto` has a new `createdByUserId`, the Owner who published the version from the
  console. `createdByCredentialId` is set only on versions published with an API key before 0.2.0.

`listWebhookEndpoints`, `listWebhookDeliveries`, `getVoucherRefundPolicy` and every other method are
unchanged.

## 0.1.0

First public release.
