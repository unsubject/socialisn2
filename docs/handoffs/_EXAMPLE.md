# 2026-01-15 — Phase 1 PR 2: arXiv adapter, no normalisation yet

_(Fictional example. Reflects the conventions in `_TEMPLATE.md`.)_

## What shipped this session

**PR #12 merged** (squash `a1b2c3d`) — `src/ingestion/arxiv.ts` with a cron
entry for `cs.AI`, `cs.CL`, `cs.LG`. Items land in `raw_items` with dedup
pass 1 applied. No LLM calls yet; that arrives in Phase 2.

## Context

Phase 1 PR 1 (RSS framework + general adapter) shipped two days earlier.
arXiv was the next adapter in BUILD-PHASES because its rate limits are
predictable and the morning routine already cites cs.AI listings.

## Decisions made and why

1. **Atom feed over OAI-PMH.** arXiv exposes both; Atom is simpler and the
   3-second rate-limit guidance is easier to honour with a single endpoint.
   OAI-PMH wins for bulk backfill, but Phase 1 is "raw_items only" so the
   incremental Atom path is sufficient. Revisit at Phase 5 PR 1 backfill.

2. **Three categories, not all of `cs.*`.** SPEC §6.3 names cs.AI, cs.CL,
   cs.LG. Adding cs.CV, cs.NE etc. would triple volume for marginal
   signal-to-noise. Easy to extend later — config-driven.

## Tried and abandoned

- **`arxiv-api` npm package.** Wraps the same endpoints but transforms the
  response and drops abstract HTML. Reverted to a direct `fetch` plus
  `fast-xml-parser`.

## Open questions

- bioRxiv / medRxiv adapter (SPEC §6.3) — different API surface, deferred to
  a follow-up PR. Not blocking the Phase 1 phase report.

## Branch state

- `main` — PR #12 merged, SHA `a1b2c3d`. Phase 1 progress: 2 of 4 PRs done.
- `phase-1-pr-3-gdelt` — local only, not pushed yet.

## Next concrete step

Phase 1 PR 3 — GDELT adapter (`src/ingestion/gdelt.ts`) per SPEC §6.8 and
BUILD-PHASES. Write ADR-005 (rate-limit fallback to BigQuery export) in the
same PR. Branch from `main`; PR 4 (Email Worker logic + phase report) also
branches from `main`, not from PR 3.
