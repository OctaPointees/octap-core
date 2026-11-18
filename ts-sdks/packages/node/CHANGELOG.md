# Changelog

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
