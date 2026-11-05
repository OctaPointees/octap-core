---
title: Run it locally
description: Run the voucher demo on your machine, then test a real sign-in on Sui Testnet.
---

Two examples in `octap-core` use the public SDK methods. Run both from the repository root after [setting up the workspace](/get-started/installation/#use-them-today).

## Voucher demo

This runs a full paid claim against a real API with a disposable database. It needs Docker. Enoki, Sui and the customer signature are mocked, so it proves the SDK flow, not a real Testnet transaction or Google sign-in.

```sh
npm run demo:sdk:local
```

It reads the balance, claims a voucher, hands off the signature, finalizes, has the customer sign the voucher's use, then checks the saved state. Read `scripts/sdk-voucher-demo.mjs` to see the backend side of the flow.

To run the same flow against your own API, set these in your shell. It stops at the customer signature, because only the customer can sign.

```sh
OCTAP_API_URL=… OCTAP_API_KEY=… OCTAP_DEMO_MEMBER_ID=… OCTAP_DEMO_VOUCHER_ID=… OCTAP_DEMO_RUN_ID=… \
  npm run demo:sdk
```

## Real sign-in on Testnet

`ts-sdks/examples/browser-auth` is a page with no framework, and a small server that plays your backend. Use it to check a paid claim with a real Google account. Mocked tests can't prove this. It is a local harness, so never deploy it.

1. Run Core's API, worker and indexer with `ENOKI_API_KEY` set and `SUI_NETWORK=testnet`.
2. Prepare an active, provisioned organization, an API key with the `read` and `write` scopes, and an active paid voucher.
3. Register your Google client ID in the Enoki portal, and add `http://localhost:4001` to its authorized JavaScript origins.
4. Start the example:

   ```sh
   npm run build
   OCTAP_API_KEY=… OCTAP_ORGANIZATION_ID=… GOOGLE_CLIENT_ID=… OCTAP_VOUCHER_ID=… \
     node ts-sdks/examples/browser-auth/server.mjs
   ```

5. Open `http://localhost:4001` and sign in. The page shows your `memberId` and `suiAddress`. Reload to check that the session restores.
6. Give that member enough confirmed points with an earn, and wait for it to confirm.
7. Press **Claim voucher**. The page shows the `RESERVED` claim, the finalized result, then the claim as `AVAILABLE`.

Set `OCTAP_EXAMPLE_RUN_ID` to start a new claim instead of resuming the last one.
