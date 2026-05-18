# ADR-011: Backfill RSS history strategy — skip historical, observe forward

- **Status:** superseded by [ADR-012](012-backfill-skip-all-historical-sources.md)
- **Date:** 2026-05-17
- **Resolves:** none (Phase 5 PR 1 prerequisite — SPEC §13 ambiguity)

> **Superseded.** This ADR kept the GDELT half of SPEC §13 step 1 on
> the reasoning that GDELT has a queryable historical backlog. That
> reasoning was incomplete: `src/ingestion/gdelt.ts` is a per-cluster
> enrichment adapter, not a discovery firehose, so there is no v1 path
> for GDELT to drive a 30-day historical signal window without a new
> topic-seed query layer that doesn't exist. ADR-012 corrects the
> scope by skipping BOTH RSS and GDELT-as-discovery and restoring the
> original "skip historical, observe forward" framing. Body below kept
> intact for audit.

## Context

SPEC §13 (Backfill Strategy) step 1 directs:

> Pull a 30-day historical signal window from RSS archives and GDELT GKG.

The clause assumes RSS archives can be queried backward in time. In
practice the v1 source set (SPEC §6.1–§6.6, ~60 feeds) cannot.

RSS/Atom feeds are append-only ring buffers sized by the publisher:
typical news outlets surface the last 20–50 items, podcast feeds the
last 100 episodes, arXiv listings ~50 papers in the daily window. There
is no standard mechanism to ask "what was in the feed on day X" — the
bytes for items that have rolled off the end are simply gone from the
publisher's RSS surface. Wayback Machine snapshots of RSS XML exist but
are sparse, irregular, and produce duplicates against the live snapshot
once forward ingestion resumes.

GDELT GKG by contrast does have a queryable backlog (15-minute slices
of the full event/mention/GKG corpus going back to 2015). That half of
§13 step 1 stands.

The result: the literal spec wording is unachievable for the "RSS" half
of step 1, and the §6.9 email-bridge sources have no historical backlog
at all (BUILD-PHASES.md Phase 5 PR 1 already notes this). The question
is what to do about the RSS half.

## Decision

Phase 5 PR 1 backfill **skips the 30-day RSS historical window
entirely**. The backfill job:

1. Pulls a 30-day GDELT GKG slice (step 1, GDELT half — unchanged).
2. Skips the RSS half of step 1.
3. Runs §13 steps 2–5 (cluster, compare against YouTube channel +
   2nd-brain essay corpus, label) against the GDELT-only signal plus
   the YouTube + 2nd-brain corpora (which DO have stable historical
   access).
4. Records the truncated input set explicitly in the `backfill_run`
   row (`rss_history_status = 'skipped'`, `gdelt_window_days = 30`) so
   reviewers see the gap.

Source authority calibration (§13 step 6) at backfill time becomes a
no-op. Initial weights are the seed values from
`migrations/002_seed_sources.sql`; real per-source calibration accrues
from the first 30 days of FORWARD observation. Phase 5 PR 3
(observability) takes ownership of the recurring recalibration cron.

## Rationale

**Why skip rather than build a Wayback / News-API fetcher:**

- **Wayback snapshots are sparse and biased.** A typical major outlet's
  RSS URL has irregular CDX coverage (gaps of hours to days). The signal
  would be incomplete in ways that bias toward heavily-archived sources
  (NYT, Reuters) and against niche/expert feeds (the SPEC §6.3 sources
  that motivate this product). Calibration on biased input is worse
  than calibration on no input — it would systematically over-weight
  exactly the sources whose authority we're trying NOT to assume.
- **News API back-archives cost money and add a vendor.** The ~$5–10
  backfill budget (SPEC §13) doesn't cover a 30-day backfill across all
  §6.1–§6.6 sources via NewsAPI or similar, and adding a vendor for a
  one-time job violates the no-scraping / single-pipeline shape of
  ADR-003.
- **Forward observation is the eventual source of truth anyway.** SPEC
  §14 already commits the system to continuous recalibration from
  feedback. A 30-day forward window costs zero (it's the same crons
  that run anyway) and avoids the bias risk.
- **The GDELT half still drives the cluster-shape signal.** Steps 2–5
  (cluster, embed, compare against YouTube + 2nd-brain) work on GDELT
  alone. The thing we lose is per-source weight calibration — which is
  the part SPEC §14 already says will be recomputed live.

**What this loses, explicitly:**

- Day-0 source weights are seed values, not calibrated. First two weeks
  of candidates may surface lower-quality items from over-weighted
  sources until forward observation catches up. Mitigation: SPEC §11.3
  `/dump` plus manual pick/pass during the pilot week (SPEC §18)
  generates the same training signal that backfill calibration would
  have, just from real candidates rather than synthetic historical
  clusters.
- The `backfill_run` row will show fewer historical clusters than SPEC
  §13's literal reading implies. Documented as expected, not a
  regression.

**Alternatives considered and rejected:**

- **Build a Wayback-Machine RSS fetcher.** ~1–2 weeks of work for
  biased output. Rejected.
- **Pay for NewsAPI / GDELT BigQuery backfill of source-attributed
  historical items.** $50–200 ballpark, adds a vendor, exceeds backfill
  budget. Rejected for v1; revisitable if a future pricing analysis
  changes the math.
- **Use only the live RSS snapshot as "history".** Whatever's currently
  in each feed (typically 20–50 items) IS what the publisher considers
  current. Treating it as 30-day backlog is double-counting once
  forward ingestion catches the same items 6h later — and 20–50 items
  per source is too small to drive useful calibration anyway.
- **Defer backfill entirely.** Considered but rejected: the YouTube +
  2nd-brain comparison (steps 3–5) is genuinely useful even on a
  GDELT-only signal, and a `backfill_run` provenance row is wanted as
  a recorded baseline regardless.

## Consequences

- `src/backfill/run.ts` (Phase 5 PR 1) implements step 1 GDELT-only,
  then steps 2–5 against GDELT + YouTube + 2nd-brain corpora. No RSS
  adapter calls from the backfill path.
- `backfill_run` schema (introduced in PR 2 of Phase 0) gains an
  `rss_history_status TEXT` column (values: `'skipped'` for v1;
  reserved for `'wayback'` / `'newsapi'` if a future ADR re-opens
  this). Migration lands with Phase 5 PR 1.
- SPEC §13 step 1 wording becomes imprecise after this decision lands.
  Phase 5 PR 1 will update SPEC §13 inline to reference this ADR
  rather than overstate what the backfill does.
- Source authority computation (§13 step 6) is a no-op at backfill
  time. Phase 5 PR 3 (observability + cron) owns the recurring
  recalibration job.
- Pilot week (§18 acceptance criteria) becomes the de-facto source
  authority calibration period. The acceptance criterion "Simon picks
  ≥ 1 candidate/day he would not have found via Perplexity / Google /
  YouTube browsing" is unaffected — that gate is about candidate
  quality, not source weight accuracy.
- This ADR is forward-reversible: if a future cost or vendor decision
  opens NewsAPI / paid GDELT BigQuery, ADR-NNN can supersede by
  defining a non-`'skipped'` `rss_history_status` value and a fresh
  one-time job using the new channel.

## References

- SPEC §13 (Backfill Strategy), §14 (Feedback Loop), §18 (acceptance
  criteria), §6.1–§6.6 (source set), §11.3 (Telegram commands incl.
  `/dump`)
- ADR-003 (no-scraping policy and email-bridge architecture) — the
  boundary this decision respects
- BUILD-PHASES.md Phase 5 PR 1 — the entry point that consumes this
  decision (also notes the parallel "email-bridge sources have no
  historical backlog" caveat)
- `migrations/002_seed_sources.sql` — seed authority values used until
  forward observation catches up
