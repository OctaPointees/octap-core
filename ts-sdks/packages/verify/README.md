# @octap/verify

Checks an Octap audit evidence bundle against its seal on Sui, without trusting Octap.

Octap seals each organization's points ledger and audit log once per period (a UTC day by default), by writing the hash of that
day's facts on Sui. An Owner downloads a day's evidence bundle from the console
(`GET /v1/console/organizations/:organizationId/evidence/:periodId/bundle`) and hands the file to an
auditor. This package recomputes every hash from the facts in the file, reads the seal straight from
a Sui fullnode, and says whether they agree. It trusts nothing in the file except the facts
themselves, and no Sui package except the one it ships for that network.

## Command line

```bash
npx @octap/verify bundle.json
# or: npm install -g @octap/verify && octap-verify bundle.json
```

```text
✓ MATCH — <organizationId>, 2026-11-25T00:00:00.000Z → 2026-11-26T00:00:00.000Z
  sealed on-chain at 2026-11-26T00:05:12.000Z
  1520 ledger facts, 84 audit facts
  https://suiscan.xyz/testnet/tx/<digest>
```

| Option | Meaning |
| --- | --- |
| `--rpc <url>` | Read the seal from this Sui fullnode (gRPC) instead of the network's public one |

| Exit code | Meaning |
| --- | --- |
| `0` | MATCH: the facts are the ones sealed on Sui |
| `1` | MISMATCH: each reason is printed |
| `2` | Usage error, or the file or the seal could not be read |

## In code

```ts
import { suiSealReader, verifyBundle } from '@octap/verify';

const result = await verifyBundle(bundle, suiSealReader(bundle.seal.network));
if (result.result === 'MISMATCH') console.log(result.mismatched, result.reasons);
```

A `MISMATCH` names what disagrees:

| `mismatched` | Meaning |
| --- | --- |
| `ledger`, `audit` | That section's facts are not the ones sealed |
| `manifest` | The manifest is not the one sealed: another organization, period or chain link |
| `seal` | There is no genuine seal at that id |

`verifyRecomputation` checks the recomputation the console's Verify button asks Core for, in the
same way. `buildManifest`, `manifestHash`, `canonicalJson` and `sha256Hex` are exported, so you can
rebuild the hashes yourself.

## Networks

The seal package is pinned per network in `AUDIT_NETWORKS`. A bundle names the network its seal is
on, never which package to believe. Only `testnet` is published for now. A bundle sealed on any
other network is refused, and the command exits with code `2`.
