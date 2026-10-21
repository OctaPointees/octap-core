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
- Before opening a PR: `npm run lint && npm run build && npm run typecheck && npm test && npm run check:bootstrap` must all pass. Prefer verifying a new repository method live against the local
  `docker-compose` Postgres (throwaway script, deleted after) over trusting it unverified — this
  codebase's own convention is "verified live, not just unit tests" for anything DB- or
  chain-facing.

## Working across sessions / splitting work

Tickets with no dependency on each other (check each ticket's own "blocked by" / "stacked on"
note) are safe to pick up in a fresh session or in parallel — a new session needs nothing from a
prior conversation, only this file, `docs/roadmap.md`, and the target ticket's own Linear
description. Don't assume continuity; re-check Linear + `gh pr list` at the start of any session
rather than trusting anything that might be stale.
