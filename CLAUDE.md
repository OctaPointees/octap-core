# OctaP Core

Read [docs/roadmap.md](docs/roadmap.md) first — it is the single source of truth for what's
built vs. not, and lists every known gap deliberately left open. Read
[docs/implementation-guide.md](docs/implementation-guide.md) before adding any feature; it's the
exact file/layer pattern every domain in this repo follows (`credits`/`rewards` are the reference
implementations, copy their shape).

## Where things are tracked

- **Linear**: project "OctaP Back-end", team "OctaPointees". Check it for ticket status/estimates,
  not this file — it changes too often to keep here.
- **GitHub**: `OctaPointees/octap-core`. Run `gh pr list --state all` to see what's open/merged —
  don't assume from a prior conversation, PR state moves fast.
- A ticket's own Linear description is kept up to date with its PR link, verification notes, and
  known gaps as work lands — read the ticket before starting work on it, not just this file.

## Conventions (not written anywhere else)

- **Conventional Commits** for every commit and PR title.
- **Branch names** follow Linear's own suggested slug: `<author>/<ticket-slug>`.
- **No AI-tool attribution anywhere** — no `Co-Authored-By: Claude`, no "Generated with" lines, in
  commits, PR descriptions, or code. This repo's history should read as the author's own work.
- **Stacked PRs**: when a change genuinely depends on another PR that hasn't been reviewed yet,
  base the new PR on that PR's branch (not `main`), and say so in the PR description. Retarget to
  `main` once the upstream PR merges — don't leave it stacked.
- Before opening a PR: `npm run format:check && npm run lint && npm run build && npm run typecheck && npm run test:coverage && npm run check:bootstrap` must all pass (`test:coverage` runs unit + integration tests; integration needs Docker or Podman — see `api/tests/README.md`). CI runs the same checks but can't block a merge (no branch protection on this plan), so check it before merging. A new repository method or route
  gets an integration spec under `api/tests/integration` (real Postgres/Redis) rather than a
  throwaway script — this codebase's convention is "verified live, not just unit tests" for
  anything DB-facing. Chain calls stay faked in tests; verify those against testnet by hand.

## Code standards

These apply to every PR. Lint, format, and typecheck enforce what they can; the rest is review.

- **Shape**: follow [docs/implementation-guide.md](docs/implementation-guide.md) for where a feature's
  files go (wire types → schema → repository → domain service → controller → SDK → tests). Not
  repeated here.
- **Imports inside `api/`**: to reach another top-level area of `api/src`, use the subpath imports
  `api/package.json` defines — `#api/…`, `#domain/…`, `#infra/…` (e.g.
  `import { CreditsRepository } from '#infra/db/repositories/credits.repository.js'`). Use a relative
  import only within the same folder (`./x.js`) or one level up (`../dto/x.js`). ESLint
  (`no-restricted-imports`) fails on any `../../` import in `api/src`. Keep the `.js` extension
  (NodeNext ESM). Tests import `api/src` the same way. Across workspace packages, import the package
  name (`@octap/contracts`, `@octap/chain`, …), never a path into another package.
- **Formatting**: Prettier (`npm run format`); don't hand-format or argue style in review.
- **Database**: drizzle for every query, through a repository in `infra/db/repositories`. Raw SQL
  only where drizzle can't express it (today: the session settings in `infra/db/rls.ts`). Nothing
  outside `infra/db/postgres.provider.ts` touches the `postgres` client directly. Writes that must
  happen together go in one `db.transaction`. Helpers that must join the caller's transaction (like
  `acceptCommand`) take a `tx`, not open their own.
- **Chain and vendors**: `@mysten/*` is only imported under `api/src/infra/clients/`; Move calls are
  built in `@octap/chain`. Signer keys (`SUI_ISSUER_PRIVATE_KEY`, `SUI_PROGRAM_ADMIN_PRIVATE_KEY`) are
  only read by worker-only modules, never by anything `AppModule` loads.
- **Redis**: inject the shared ioredis client with `@Inject(REDIS_CLIENT)`; never create another
  connection.
- **HTTP out**: global `fetch` (webhook delivery, SDKs). No axios or other HTTP client.
- **Validation and errors**: controllers check required body fields and throw `BadRequestException`;
  domain services throw Nest `HttpException`s (`NotFoundException`, `ConflictException`, …) with a
  message a merchant can act on. Another tenant's resource is a 404, never a 403.
- **Logging**: Nest `Logger` (`new Logger(Class.name)`), never `console` in `api/src`.
- **Config**: read an env var where it's used. Secrets are read lazily via `requireEnv` so the app
  still boots without them. Every variable goes into `.env.example` in the same change.
- **Crypto**: `node:crypto` only (hashing, HMAC, random ids).
- **Tests**: Vitest; see [api/tests/README.md](api/tests/README.md) for what goes in unit vs.
  integration.

## Working across sessions / splitting work

Tickets with no dependency on each other (check each ticket's own "blocked by" / "stacked on"
note) are safe to pick up in a fresh session or in parallel — a new session needs nothing from a
prior conversation, only this file, `docs/roadmap.md`, and the target ticket's own Linear
description. Don't assume continuity; re-check Linear + `gh pr list` at the start of any session
rather than trusting anything that might be stale.
