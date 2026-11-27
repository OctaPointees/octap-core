# Changesets

Every PR that changes a published `@octap/*` package adds a changeset: run `npx changeset`, pick
the packages and the bump (patch, minor or major; pre-1.0 a breaking change is a minor), and write
one line a user of the package would want in its CHANGELOG. Commit the file it creates here.

CI fails a PR that changes a published package without a changeset. When the change ships nothing
(a test, a comment), add an empty one: `npx changeset add --empty`.

## Releasing

The Release workflow does it on every push to `dev`:
- While changesets are waiting, it opens or updates the "chore(release): version packages" PR. That
  PR runs `npm run version-packages`: it applies every changeset, bumps each version, updates every
  `@octap/*` range that points at a bumped package, and writes the CHANGELOGs.
- When that PR is merged, it runs `npm run release`: it builds, publishes each package whose version
  is not on npm yet in dependency order, tags it, and creates a GitHub release.

By hand, the same: `npm run version-packages` in a PR, then `npm ci && npm run release` from `dev`
once it is merged, with `git push --follow-tags`.

Never edit a package's `version` or an `@octap/*` range by hand: npm installs the published copy
whenever a range stops covering the version in this repo.
