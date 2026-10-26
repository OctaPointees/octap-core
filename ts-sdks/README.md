# TypeScript SDK workspace family

| Package | Role |
| --- | --- |
| packages/contracts (@octap/contracts) | Shared wire types for points and vouchers |
| packages/node (@octap/sdk) | Merchant Node client over REST |
| packages/browser (@octap/browser-sdk) | Browser-safe client for customers |

The repository root manages all npm workspaces and one lockfile. Neither SDK imports API internals.
Browser SDK options contain no merchant credentials. Planned SDK work is in [the roadmap](../docs/roadmap.md).

For a runnable merchant example, see the [Node SDK voucher demo](examples/README.md): prepared member balance → points-to-voucher claim → redemption → persisted-state verification.
