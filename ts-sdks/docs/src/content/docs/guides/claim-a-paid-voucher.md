---
title: Claim a paid voucher
description: Exchange a customer's points for a voucher, across your server and their device.
---

This flow uses both SDKs. Your server reserves the voucher, the customer signs on their device, and the chain debits the points.

| Step | Where | What happens |
| --- | --- | --- |
| 1. Reserve | Your server | Holds the points and one unit of stock. The voucher is `RESERVED`. |
| 2. Sign and finalize | Customer's browser | The customer signs, and the transaction goes to the chain. |
| 3. Confirm | Your server | Read the claim until it is `AVAILABLE`. |
| 4. Redeem | Your server | Use the serial at checkout. No points move here. |

## 1. Reserve on your server

Verify the customer first, and derive the key from something stable. A retry with this key resumes the same claim.

```ts title="POST /api/claim"
const { memberId, active } = await client.verifyCustomer(idToken);
if (!memberId || !active) throw new Forbidden();

const claim = await client.claimVoucher(voucherId, {
  organizationEndUserId: memberId,
  idempotencyKey: `claim-${memberId}-${voucherId}`,
});

return claim;
```

A paid claim returns `status: 'RESERVED'`, `pointsDeducted: 0`, `digest` and `transactionBytes`. A free voucher returns `AVAILABLE` directly, so there is nothing to sign.

## 2. Sign and finalize in the browser

```ts
const claim = await (await fetch('/api/claim', { method: 'POST', headers })).json();

if (claim.status === 'RESERVED') {
  try {
    await auth.signAndFinalize(claim);
  } catch (error) {
    if (error.code === 'outcome-unknown') {
      // It may have failed, or may still land. Read the claim. Don't start a new one.
    }
  }
}
```

The private signing key never leaves the device. `signAndFinalize` never retries, and it refuses anything but a `RESERVED` claim with bytes.

If you need the signature without sending it, use `auth.signTransaction(claim.transactionBytes)`, then call `finalizeVoucherClaim` on your server with the signature and digest.

## 3. Confirm on your server

```ts
const claim = await client.getVoucherClaim(ownershipId);

switch (claim.status) {
  case 'AVAILABLE': // Owned. Show the voucher.
  case 'RESERVED':  // Not owned yet. Show it as pending, and read again later.
  case 'CANCELLED': // Failed or abandoned. Points and stock were released. A new key is safe now.
}
```

Check that the claim's `organizationEndUserId` is the verified member before you return it. Your API key can read every member's claims, and a claim holds a redeemable serial code.

## 4. Redeem at checkout

Redeeming uses the voucher. The points were already debited, so no points move.

```ts
const redeemed = await client.redeemVoucher({
  serialCode: claim.serialCode,
  receiptReference: order.id,
});
```

A serial can only be redeemed once. This call has no idempotency key, so after an unknown outcome, read the status before you retry.

## Rules for your interface

Whatever your interface looks like, follow these:

- A `RESERVED` voucher isn't owned. Show it as pending until it is `AVAILABLE`.
- Never retry automatically after an unknown outcome.
- Resume with the same key. Use a new key only after `CANCELLED`.
- An unsigned claim is released after 30 minutes, which returns its points and stock.

A member can hold only one non-cancelled claim per voucher.
