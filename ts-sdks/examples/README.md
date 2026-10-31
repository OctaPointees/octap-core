# Customer-signed voucher claim example

Paid voucher conversion uses Sui as the debit authority. Vouchers and their serials stay in PostgreSQL. Keep merchant API credentials on the server.

## Development prerequisites

Use Node >=24.15 <25. Run `npm ci`, `npm run build`, migrations, the API and worker/indexer. Prepare an ACTIVE provisioned organization, an enrolled member with a linked zkLogin address/on-chain CreditAccount and settled points, and an active reward in stock. Apply the new partial voucher/member unique-index migration before allowing new claims after cancellation.

The merchant server initiates a claim through `@octap/sdk`:

```typescript
const claim = await merchant.claimVoucher(voucherId, {
  organizationEndUserId: memberId,
  idempotencyKey: stableClaimKey,
});
```

For a paid claim, `status` is RESERVED, `pointsDeducted` is zero, and `digest`/`transactionBytes` describe the sponsored transaction. Send that result to the intended customer's device. Sign `transactionBytes` with the customer's existing zkLogin/Enoki session; the SDK does not create, retain or export the customer's private signing material.

```typescript
// Customer device: signWithCustomerSession is supplied by the host application's login flow.
const signature = await signWithCustomerSession(claim.transactionBytes);
await customer.finalizeVoucherClaim({ digest: claim.digest, signature });
```

`finalizeVoucherClaim` is available in the Node and browser SDKs and calls the public `/v1/credits/redeem/finalize` endpoint. A customer client does not need a merchant credential for this call. Invalid signatures cannot authorize the chain transaction.

The merchant server can read `getVoucherClaim(ownershipId)` or retry the same claim key to recover the current persisted state. Wait for AVAILABLE before redeeming the serial. After a timeout, inspect state and allow the indexer/digest reconciler to settle the existing operation; do not create a new key or assume failure. RESERVED stays unusable while the chain outcome is unknown. Definitive failure produces CANCELLED and releases stock/point holds; a new claim may then use a new key. Free rewards become AVAILABLE immediately.

## Runnable demo

With Docker Desktop running:

```powershell
npm run demo:sdk:local
```

The demo builds the workspace, creates disposable PostgreSQL/Redis, applies migrations, starts the real API, and exercises reserve, signature handoff, finalize, state reads and serial redemption via the public SDK. It verifies 100 -> 75 points, a single redeemed coupon, current-state claim replay and duplicate-use rejection. Only external Enoki/Sui sponsorship, customer signature and chain verdict are mocked. It does not prove a live Testnet transaction or Google login. No real wallet or existing database is used. Cleanup attempts every resource even after another closer fails.

`runVoucherDemo(client, { memberId, voucherId, idempotencyKey, signTransaction })` can instead use a host-provided asynchronous customer signing callback `(transactionBytes, digest) => signature`. Do not sign as the issuer. With no callback the demo returns a pending claim and prints the digest/bytes; finalize from the customer's session and inspect state without claiming again.

`npm run demo:sdk` reads OCTAP_API_URL, OCTAP_API_KEY, OCTAP_DEMO_MEMBER_ID, OCTAP_DEMO_VOUCHER_ID and OCTAP_DEMO_RUN_ID from the shell (never automatically from .env). It performs preflight checks and stops at customer signing. It does not automatically retry mutations. Use a dedicated development member; repeat runs stop when ownership exists.

## Validation

```powershell
npm run test:demo:sdk
npm run test:integration -- rewards
```

HTTP-fixture tests verify SDK orchestration. Integration tests verify real PostgreSQL/Redis holds, concurrent claims, rollback, finalization, stock release, tenant isolation and single-use redemption with chain adapters replaced. A live Testnet customer session remains necessary to validate the actual Enoki signature path.

The Node SDK also exposes `updateVoucher(id, patch)` for reward management. See the [rewards domain guide](../../api/src/domain/rewards/README.md).
