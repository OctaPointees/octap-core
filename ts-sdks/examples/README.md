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
// Customer device, with @octap/browser-sdk: signs locally, then calls the public finalize route.
await auth.signAndFinalize(claim);
```

A customer client does not need a merchant credential for this call. Invalid signatures cannot authorize the chain transaction. A host that signs some other way can pass its signature to the Node SDK's `finalizeVoucherClaim`.

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

## Browser auth example

`browser-auth/` is a local test page for `@octap/browser-sdk` with no framework. Its small server plays a merchant: it verifies the customer's token and claims with an API key that never reaches the page. It is not for deployment.

This is how to check a paid claim with a real Google account on Testnet, which mocked tests cannot prove:

1. Run Core's API, worker and indexer with `ENOKI_API_KEY` set and `SUI_NETWORK=testnet`.
2. Prepare an ACTIVE provisioned organization, an API key with `read` and `write` scopes, and an active paid voucher.
3. Register your Google client ID in the Enoki portal, and add `http://localhost:4001` to its authorized JavaScript origins.
4. Start the example from the repository root, in Git Bash:

   ```sh
   npm run build
   OCTAP_API_KEY=... OCTAP_ORGANIZATION_ID=... GOOGLE_CLIENT_ID=... OCTAP_VOUCHER_ID=... \
     node ts-sdks/examples/browser-auth/server.mjs
   ```

5. Open `http://localhost:4001` and sign in with Google. The page shows your `memberId` and `suiAddress`. Reload to check that the session restores.
6. Give that member enough confirmed points through a merchant earn, and wait for the earn to confirm.
7. Press **Claim voucher**. The page shows the RESERVED claim, then the finalized result, then the claim as AVAILABLE. Press **Sign out** to finish.

Set `OCTAP_EXAMPLE_RUN_ID` to start a new claim instead of resuming the last one.
