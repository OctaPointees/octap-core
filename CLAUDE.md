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

## Working across sessions / splitting work

Tickets with no dependency on each other (check each ticket's own "blocked by" / "stacked on"
note) are safe to pick up in a fresh session or in parallel — a new session needs nothing from a
prior conversation, only this file, `docs/roadmap.md`, and the target ticket's own Linear
description. Don't assume continuity; re-check Linear + `gh pr list` at the start of any session
rather than trusting anything that might be stale.
