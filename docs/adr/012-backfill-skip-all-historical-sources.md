# ADR-012: Backfill skips all historical signal sources — supersedes ADR-011

- **Status:** accepted (supersedes ADR-011)
- **Date:** 2026-05-17
- **Resolves:** none (Phase 5 PR 1 prerequisite — corrects ADR-011's scope)

## Context

ADR-011 ("skip historical RSS, observe forward") committed to skipping
the RSS half of SPEC §13 step 1 while keeping the GDELT half, on the
reasoning that GDELT GKG has a queryable historical backlog. That
reasoning was incomplete — written without inspecting how `gdelt.ts` is
actually shaped in this repo.

What the existing GDELT adapter (`src/ingestion/gdelt.ts`) exposes:

- `fetchGkg(input: GdeltQueryInput)` — single per-query call, two HTTP
  fetches (TimelineVolRaw + ArtList with `maxrecords=250`), returns a
  per-query coverage summary (article count, country/language counts,
  top outlets).
- `lookupOrFetchCoverage(db, clusterId, input)` — wraps the above with
  a 6h coverage cache keyed by query+window.

Both are **per-cluster enrichment** primitives. There is no firehose
mode: GDELT GKG returns articles matching a specific query within a
specific window, not "every article published in the last 30 days."
SPEC §6.8 already frames GDELT as enrichment (Stage 4 helper invoked
on demand per cluster), not as a discovery source.

To turn GDELT into a 30-day discovery source you would need a new
topic-seed query layer: a curated list of broad queries (per SPEC §8
primary domain, or harvested from Simon's YouTube channel keywords, or
some other taxonomy) run across the 30-day window to produce a corpus
big enough to cluster. That layer doesn't exist, isn't one PR of
design, and isn't on the BUILD-PHASES roadmap.

So ADR-011's "GDELT-half kept" half is unachievable today without
inventing infrastructure outside the scope of Phase 5 PR 1.

Separately: SPEC §13 step 3 ("for each historical cluster, compare its
embedding against (a) YouTube last 12 months and (b) 2nd-brain essay
corpus") iterates over historical clusters. With both RSS and GDELT
ruled out as discovery sources for v1, there are no historical
clusters, so steps 3-5 don't execute. Step 6 (source authority
adjustments) was already deferred to forward observation in ADR-011.

The user's original framing was "skip historical, observe forward" —
singular. ADR-011 split it into two halves and kept the GDELT half on
incorrect grounds. ADR-012 restores the original singular shape.

## Decision

Backfill in Phase 5 PR 1 **skips ALL historical discovery sources**
(RSS *and* GDELT-as-discovery). The backfill job:

1. Loads Simon's YouTube channel last-12-months videos via the
   YouTube Data API client (`src/ingestion/youtube_data.ts`,
   landed in PR #61) — title + description, optional cleaned subtitles
   when available.
2. Records what's available in the 2nd-brain essay corpus
   (`archive_search` is queryable on demand; we record corpus
   availability but do not pre-fetch).
3. Writes a single `backfill_run` row with full provenance:
   - `rss_history_status = 'skipped'`
   - `gdelt_history_status = 'skipped'`
   - `youtube_corpus_size` = count of videos pulled
   - `brain_corpus_status = 'available'` (or `'unreachable'` on MCP
     failure)
   - `historical_clusters = NULL` (no discovery → no clusters)
   - `positive_labels = NULL`, `negative_labels = NULL`
   - `authority_adjustments = NULL`

Source authority calibration (§13 step 6) continues to accrue from
forward observation — Phase 5 PR 3 (observability) owns the recurring
recalibration cron, as ADR-011 already specified.

## Rationale

**Why fully skip rather than build a GDELT topic-seed layer:**

- The topic-seed design (which queries? per-domain? per-YouTube-keyword?
  with what dedup?) is its own meaningful design surface, not a side
  detail of a backfill PR. Building it inside Phase 5 PR 1 would
  conflate "ship the backfill" with "design a new ingestion mode."
- The output value at v1 is low: even with 5-15 topic-seed queries
  yielding 1500-3000 articles, the resulting clusters are
  GDELT-source-biased (the same set of news outlets GDELT covers
  globally), which is a different distribution from the §6.1-§6.6
  source set the live system will see. Calibrating on that distribution
  would mislead more than it informs.
- Forward observation costs zero (the live crons run anyway) and
  produces calibration data drawn from the actual source mix. SPEC §14
  already commits to continuous recalibration from feedback.

**Why keep the YouTube + 2nd-brain corpus load:**

- Both have stable historical access (YouTube Data API + 2nd-brain MCP
  `archive_search` already live in production).
- They serve a different purpose from discovery: they're the
  "what has Simon already covered" baseline that Stage 5 archive overlap
  uses on every forward run. Pre-loading the YouTube last-12mo corpus
  ensures the FIRST forward run after deploy has a complete baseline
  for archive overlap; without it, early-day candidates would compare
  only against episodes already vectorised in 2nd-brain (which may not
  include the most recent uploads).
- This is genuinely useful, cheap (~$0.05 of embedding cost), and lets
  the `backfill_run` row record a real corpus size rather than just
  being a provenance placeholder.

**What this loses vs ADR-011's intended (but unachievable) shape:**

- Nothing additional. ADR-011 already conceded:
  - No per-source authority calibration from historical data
    (deferred to forward observation).
  - Day-0 weights are seed values from
    `migrations/002_seed_sources.sql`.
  - `backfill_run.historical_clusters` would be smaller than SPEC §13's
    literal reading implied.
  - All three of those points still hold under ADR-012, just with the
    GDELT path also marked skipped.

**Alternatives considered:**

- **Keep ADR-011 and implement a GDELT topic-seed firehose in Phase 5
  PR 1.** Rejected as out-of-scope (see above) — that's a separate
  design.
- **Defer backfill entirely (no PR).** Rejected: the YouTube + 2nd-brain
  corpus load IS valuable as a Stage-5 baseline warmup, and a
  `backfill_run` row is wanted as a recorded deployment baseline
  regardless.
- **Implement the full SPEC §13 by also building the topic-seed layer.**
  Rejected: scope explosion. If a future ADR re-opens GDELT discovery,
  it gets its own PR and supersedes this one.

## Consequences

- `src/backfill/run.ts` (Phase 5 PR 1) implements only the YouTube +
  2nd-brain corpus load + `backfill_run` provenance row. No GDELT calls.
  No RSS calls. No historical clustering.
- `backfill_run` schema (introduced in PR 2 of Phase 0) gains
  status/provenance columns added by Phase 5 PR 1's migration:
  - `rss_history_status TEXT` (v1: always `'skipped'`)
  - `gdelt_history_status TEXT` (v1: always `'skipped'`)
  - `youtube_corpus_size INT`
  - `brain_corpus_status TEXT` (`'available'` | `'unreachable'`)
  All NULLable for forward-compat with a future GDELT-discovery ADR.
- ADR-011's status flips to **superseded by ADR-012**. A pointer note
  is added at the top of ADR-011 directing readers here; the body
  stays intact for audit (the reasoning gap is itself interesting
  history).
- SPEC §13 wording is updated inline (in Phase 5 PR 1's diff, not
  here) to reference ADR-012 and reflect the v1 reality.
- Phase 5 PR 1 becomes materially smaller than its original SPEC §13
  scope implied — ~300 lines instead of the multi-module ingestion
  build that a full SPEC §13 read would suggest. The deferred work
  (GDELT topic-seed discovery) is a separate future PR if and when an
  ADR re-opens it.
- This decision is forward-reversible. A future ADR may re-open GDELT
  discovery (or RSS-backfill via Wayback / NewsAPI) by setting
  non-`'skipped'` status values and adding the corresponding ingestion
  path; that ADR supersedes this one.

## References

- ADR-011 (superseded by this ADR) — the prior, narrower take that
  this corrects
- SPEC §13 (Backfill Strategy), §14 (Feedback Loop), §6.8 (GDELT
  enrichment role), §18 (acceptance criteria)
- `src/ingestion/gdelt.ts` — the per-cluster enrichment adapter whose
  shape disqualifies it as a discovery source for v1
- `src/ingestion/youtube_data.ts` — Blocker-1 YouTube Data API client
  used for the YouTube corpus load
- `src/lib/two_brain_client.ts` — `archive_search` MCP client used to
  verify 2nd-brain corpus reachability
- BUILD-PHASES.md Phase 5 PR 1 — the entry point that consumes this
  decision
- `migrations/002_seed_sources.sql` — seed authority values used until
  forward observation catches up
