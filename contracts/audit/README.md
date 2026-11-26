# octap_audit

Seals of each organization's audit evidence (OCT-77). The Core worker closes an organization's
evidence period, hashes it into a manifest (`@octap/verify`), and calls `evidence_seal::seal`.
Anyone can then check a period against its seal, without trusting OctaP (`npx @octap/verify`).

- **`EvidenceSeal`** is frozen when created. Nobody can edit or delete it, OctaP included.
  `sealed_at_ms` comes from the chain's clock, so a seal can't be backdated.
- **`SealerCap`** is the only way to create a seal, so the type proves who sealed it. It is held
  by the issuer address, the key `ChainSubmitWorker` already signs with.
- **`SealRegistry`** is shared. It keeps each organization's latest seal and enforces the chain:
  a seal names the previous seal's manifest hash and starts where it ended or later. A sealed
  period can't be sealed again, replaced, or have another period inserted before it.
- **Immutable package.** The `UpgradeCap` was destroyed (`0x2::package::make_immutable`), so no
  upgrade can ever add another way to create a seal. A change is a fresh publish under a new id.

It is a separate package from `octap` on purpose: adding it to `octap` would force a fresh
publish there and a re-provision of every program (see `../sui/DEPLOYMENTS.md`).

```sh
sui move test     # from this folder
```

Deployments: [DEPLOYMENTS.md](DEPLOYMENTS.md).
