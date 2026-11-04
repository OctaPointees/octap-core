# TypeScript SDK workspace family

| Package | Role |
| --- | --- |
| packages/contracts (@octap/contracts) | Shared wire types for points and vouchers |
| packages/node (@octap/sdk) | Merchant Node client over REST |
| packages/browser (@octap/browser-sdk) | Firebase-style customer sign-in and signing over Enoki, for merchant websites |

The repository root manages all npm workspaces and one lockfile. Neither SDK imports API internals.
Browser SDK options contain no merchant credentials, so balance, voucher and claim calls stay on the merchant's backend through the Node SDK. OctaP's own websites call the API directly and use neither SDK. Planned SDK work is in [the roadmap](../docs/roadmap.md).

For a runnable merchant example, see the [Node SDK voucher demo](examples/README.md): prepared member balance → points-to-voucher claim → redemption → persisted-state verification.

Developer documentation is in [docs](docs/README.md). Run it locally with `npm run dev` from that folder.
