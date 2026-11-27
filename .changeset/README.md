# Changesets

Every PR that changes a published `@octap/*` package adds a changeset: run `npx changeset`, pick
the packages and the bump (patch, minor or major; pre-1.0 a breaking change is a minor), and write
one line a user of the package would want in its CHANGELOG. Commit the file it creates here.

To release, open a PR that runs `npm run version-packages`: it applies every changeset, bumps each
version, updates every `@octap/*` range that points at a bumped package, and writes the
CHANGELOGs. Once that PR is merged, run `npm run release` from `dev`: it publishes each package
whose version is not on npm yet, in dependency order, and tags it.

Never edit a package's `version` or an `@octap/*` range by hand: npm installs the published copy
whenever a range stops covering the version in this repo.
