# Changelog

## 0.3.0

### Added

- `getLicense()` (OCT-329): your organization's license (plan, `startsAt`, `endsAt`, `state`
  `ACTIVE`/`GRACE`/`EXPIRED`, what it includes) and how much of each limit is in use this license
  month. `read` scope.
- License limits (OCT-329): a request the license doesn't cover answers **402** with `code`
  `LICENSE_LIMIT_REACHED` (`limit`, `used`, `allowed`) or `LICENSE_FEATURE_NOT_INCLUDED`
  (`feature`). Earn, POS reserve and paid claims stop at 110% of the monthly transactions; voucher
  batches need `voucher.batches`, sandbox keys need `sandbox`. Types: `LicenseErrorBody`,
  `LicenseErrorCode`.
- Webhook `license.usage_threshold` (`LicenseUsageThresholdEventData`): sent once per license month
  at 80% and at 100% of the monthly transactions.
- License expiry (OCT-329): 7 days after a license ends (its grace period), earns, POS reserves and
  paid voucher claims answer **402 `LICENSE_EXPIRED`**; everything else keeps working. Webhook
  `license.expiry_notice` (`LicenseExpiryNoticeEventData`) is sent 30, 7 and 1 days before the end,
  when the grace period starts and when it is over (`stage`), once each. Types:
  `LicenseExpiryStage`, `LICENSE_EXPIRY_STAGES`, `LICENSE_EXPIRY_REMINDER_DAYS`.
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
