# Core to Web package handoff

Core owns shared wire types and SDK implementation. Web consumes immutable package artifacts.
The scaffold uses a committed npm tarball because no package registry has been configured.
@octap/contracts is the wire-type package; contracts/sui is the separate Move source tree.

## Refresh a wire contract

1. Review changes in ts-sdks/packages/contracts and increase its version when the public contract changes.
2. In Core, run npm ci and npm run build.
3. From the Core root, pack into the target Web checkout:

```sh
npm pack --workspace @octap/contracts --ignore-scripts --pack-destination ../OctaP_Web/vendor
```

4. In Web, update @octap/contracts in package.json to file:vendor/octap-contracts-<version>.tgz.
5. Record the Core source commit and package version in Web/vendor/README.md.
6. Run npm install, lint, build and typecheck in Web; commit its tarball and lockfile together.

The checked-in tarball is a generated distribution, not a second source of domain rules.
Do not edit unpacked dependencies or copy Core services into Web. API DTOs and SDK behavior
must stay compatible. The Node SDK remains for merchant server integrations; browser code may
consume only public wire types and the browser-safe SDK when those helpers are implemented.

When a registry is configured, release these packages from Core and replace Web's file dependency
with a pinned package version. Registry publication, credentials and release automation remain
future work. Every repository must build from its own checkout and lockfile.
