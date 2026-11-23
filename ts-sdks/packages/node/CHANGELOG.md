# Changelog

## Unreleased

### Added

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

### Changed

- `VoucherStatus` has a new value, `ARCHIVED`: a voucher of an archived batch that never went
  live. `listVouchers` and `getVoucher` can return it. It can't be edited, submitted or claimed;
  importing its code in a new batch brings it back as `DRAFT`. Code that switches on `status`
  should handle it.

## 0.2.0

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
