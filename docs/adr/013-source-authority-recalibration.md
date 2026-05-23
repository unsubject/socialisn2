# ADR-013: Source-authority recalibration via Bayesian Beta-Bernoulli

- **Status:** accepted
- **Date:** 2026-05-22
- **Resolves:** SPEC §14 (feedback loop) — operationalises step 6 of §13
  ("authority adjustments") for the forward-observation regime ADR-011 /
  ADR-012 committed to.

## Context

Every source carries an `authority_score` in `[1, 100]` (SPEC §6.1 / §8 /
§9.1). The seed values landed in `migrations/002_seed_sources.sql` +
`migrations/010_seed_sources_coverage.sql` are hand-curated guesses by
Simon's editorial judgement. SPEC §14 commits to "continuous
recalibration" — over time, sources whose items get picked should drift
up and sources whose items get passed should drift down.

ADR-011 deferred this to forward observation. ADR-012 ratified that
shape (no historical backfill of authority adjustments) and pointed at
"Phase 5 PR 3 (observability)" as the home for the recurring
recalibration cron. This ADR specifies the math, cadence, and integration
shape of that cron — the third deliverable of the Obs (observability)
mini-phase.

What we have to work with:

- `feedback(id, candidate_id, action, …)` with `action ∈ {pick, pass, defer}`
  (SPEC §10.2). Rows accrue at one per decision Simon makes via
  Telegram or the MCP record_pick tool.
- `candidates(id, cluster_id, is_exclusive, exclusive_source_id, …)` —
  one row per cluster surfaced to Simon for a given run.
- `clusters` group `items`; each `items` row points to a `raw_items`
  row whose `source_id` is the underlying outlet.
- `sources.authority_score INT NOT NULL DEFAULT 50` is read by Stage 3
  scoring (`src/scoring/heuristic.ts` — authority sum + diversity
  weighting) and by Stage 4 exclusive detection
  (`src/scoring/exclusive.ts:MIN_AUTHORITY = 75`).

What we don't have:

- No per-source signal counts pre-aggregated. Anything we want has to be
  re-derived from `feedback` on every pass.
- No way to attribute a feedback row to a *single* source for the
  non-exclusive case — a candidate clusters items from many outlets, and
  one pick reflects approval of the cluster's combined signal, not of
  any one source.

## Decision

A daily cron at **04:00 UTC** computes a Bayesian Beta-Bernoulli
posterior over each source's pick-rate from the last **30 days** of
feedback and writes the posterior mean (× 100, rounded, clamped to
`[1, 100]`) back to `sources.authority_score`.

The prior is anchored on a new per-source column `authority_score_seed`
(added by `migrations/015_recalibrate_kind_and_calibration.sql`,
backfilled from `authority_score` at migration time):

- `α₀ = k × seed/100`
- `β₀ = k × (1 − seed/100)`
- `k = RECALIBRATE_PRIOR_STRENGTH` (default **20**, configurable via env)

Each pick contributes `+1` to `α`; each pass contributes `+1` to `β`;
**`action='defer'` contributes zero to both**. Posterior mean:

```
new_score = clamp([1, 100], round(100 × (α₀ + picks) / (α₀ + β₀ + picks + passes)))
```

`sources.authority_score_calibrated_at` is stamped on every successful
update. A `runs` row with `kind='recalibrate'` (the migration also
widens the `runs_kind_check` CHECK) frames each pass, so the existing
Obs-1 `/status` surface — which already shows `last_run` from the most
recent `runs` row — naturally surfaces recalibration ticks without code
changes.

The cron is registered in `src/workers/ingestion.ts:main()` alongside
`startScheduler`. Its handle's `.stop()` is called in the shutdown
sequence before the DB handle closes.

### Feedback → source join path

A feedback row is joined to source via:

```
feedback → candidates → clusters → items → raw_items → sources
```

uniformly for both exclusive and non-exclusive candidates. We do NOT
use the shortcut `candidates.exclusive_source_id` for exclusive rows.
Rationale below.

To prevent double-counting (a cluster with N items from the same
source counting one pick as N decisions), the SQL first builds a
`DISTINCT (feedback_id, source_id)` CTE, then aggregates per source.

## Rationale

**Why Beta-Bernoulli:** The conjugate prior makes the math trivial — one
arithmetic update per source, no MCMC, no optimisation loop — and the
posterior has a closed-form mean we can write back to a single integer
column. The Beta family is the textbook prior for "rate of success" with
the desirable property that the prior strength `k` is a directly
interpretable "pseudo-count" of how many decisions the seed
authority is worth.

**Why k=20 default:** A source needs to accumulate roughly its prior
strength in real decisions before the posterior departs materially from
the prior mean. With k=20 and an even split of seed 50, ten picks + zero
passes lifts the score from 50 to `(10+10)/(20+10) × 100 ≈ 67` — a
meaningful but not extreme move. k=5 would let the score swing wildly
off a small sample; k=100 would freeze the seed values in place. 20
sits in the middle and is environment-tunable for prod fine-tuning.

**Why 04:00 UTC, daily:** Scoring runs at 05:00 ET morning (= 09/10:00 UTC
depending on DST) and 14:00 ET afternoon (= 18/19:00 UTC), per
`SCHEDULE_MORNING_CRON` / `SCHEDULE_AFTERNOON_CRON` defaults. 04:00 UTC
is comfortably before both, so a recalibration pass that takes 30 seconds
of light SQL can't compete with the heavier scoring runs for DB
attention, and the morning run sees freshly-recalibrated authority
values on the same calendar day a feedback row landed.

Daily is the right cadence: feedback rows accrue at units-per-day
volume (hundreds at most), so a sub-daily cadence wouldn't see enough
change to be worth the I/O; a weekly cadence would let a hot-streak
source under-weight its run-day picks for almost a week.

The cron uses `timezone: 'UTC'` in the `node-cron` call — node-cron's
default is system local TZ, and the production VPS runs
`TZ=America/New_York`. Without the explicit pin the cron would fire at
04:00 ET, not 04:00 UTC.

**Why 30-day window:** Matches the "rolling decision window" cadence
called out informally in SPEC §14 ("recent feedback"). Long enough to
average over weekend / holiday gaps; short enough that a source which
genuinely improves (or degrades) gets credit for the recent stretch
rather than being anchored on year-old picks. The window is a constant
in `src/scheduler/recalibrate.ts` (`WINDOW_DAYS = 30`); promoting it to
env if prod tuning calls for it is a one-line change.

**Why ignore defers (don't subtract):** A `defer` decision means "I'll
come back to this" — Simon hasn't judged the cluster yet. Treating it
as a negative signal would penalise sources whose stories Simon
flagged as worth-revisiting but didn't immediately publish on. The
defer's true signal — "interesting enough to keep around" — is
captured downstream by whether the deferred candidate eventually
becomes a pick or a pass; once it does, that terminal action enters
the recalibration window. Skipping defers here keeps the prior
moderating effect intact for sources that produce many "save for
later"-bucket clusters.

**Why posterior mean (not maximum likelihood, not posterior mode):**

- *Maximum likelihood* (= picks/(picks+passes)) ignores the seed
  authority entirely. A source with one pick and zero passes shoots to
  100, then back to 50 on a single pass. Useless at small sample sizes,
  which is exactly the regime we live in for the first month after
  deploy.
- *Posterior mode* for Beta(α, β) is `(α−1)/(α+β−2)` and is only
  defined for `α > 1, β > 1`. We don't enforce that on the prior
  (seed=0 or seed=100 are legal, even if uncommon), so the mode is
  undefined or non-physical at the boundary cases. Mean is well-defined
  for any positive `α + β`.

**Why the uniform join path through items, NOT exclusive_source_id for
exclusives:**

The hybrid ("use `exclusive_source_id` when the candidate is exclusive,
walk through `items` otherwise") trades a small attribution accuracy
gain for code complexity. Under the hybrid:

- For an exclusive cluster, the pick gets credited to the first
  publisher only. Other sources in the cluster — the secondary outlets
  whose later coverage validated the scoop — get zero signal.
- For a non-exclusive cluster, the pick fans out to every contributing
  source.

The fan-out is the *desired* behaviour for non-exclusive: a cluster's
appeal is genuinely a multi-source signal, and counting it once per
source captures that. The exclusive case under uniform-fan-out
*over*-credits the secondary outlets relative to ground truth, but
their signal isn't zero — they DID contribute by independently picking
up the story, and that's worth a fractional credit. The Beta-Bernoulli
posterior naturally moderates this: with k=20 prior strength, a few
"piled onto someone else's exclusive" picks barely move the secondary
source's score.

The hybrid path also doubles the SQL surface (one join shape for
exclusives, another for non-exclusives) and complicates the testability
story (each path needs its own fixture). For a v1 calibration loop the
uniformity wins; a future ADR can promote attribution accuracy if
post-launch data shows exclusive-publisher under-crediting matters.

**Double-counting defence.** Several items in the same cluster can come
from the same source (cluster of 5 items, 2 of them from outlet A
because A syndicated its own story twice). Without intervention,
`feedback × candidates × items × raw_items` counts one pick as 2 picks
for A. The recalibration SQL builds a `DISTINCT (feedback_id, source_id)`
CTE before the per-source aggregation to neutralise this; the test suite
covers it implicitly via the "5 picks + 3 passes" test cases that fix
exact counts.

**Why per-source UPDATEs, not one SQL:** The math is easy to write in
SQL (`UPDATE sources SET authority_score = round(100*(α0 + picks)/(α0+β0+picks+passes))::int FROM (…) sub WHERE …`),
but the calibration cron runs once a day against tens-to-hundreds of
sources. The per-row loop is < 1 second total and lets us emit one
structured log line per updated source, which is meaningfully more
debuggable than a one-shot SQL. The cost trade-off would matter if
this ran every minute; at daily cadence it's noise.

**Alternatives considered:**

- *Exponentially time-decayed counts (no fixed window).* Recent picks
  weighted higher than older picks — `weight = exp(−Δt / τ)` with
  `τ ≈ 14 days`. Mentioned in SPEC §14 informally. **Documented here
  as a v2 refinement**, not implemented for v1: fixed 30-day window is
  simpler, has no `τ` to tune, and the failure mode (a source's recent
  hot-streak diluted by a 25-day-old cold week) is only meaningful
  once we have months of accumulated data — by which time we can
  observe whether decay actually improves Stage 3 scoring quality
  before adding the complexity.
- *Per-domain authority instead of per-source.* A source like Bloomberg
  publishes across economy, geopolitics, tech, etc., and its
  authority arguably differs by domain. Rejected for v1: we'd need
  attribution from feedback → domain (more fragile than to source),
  and the SPEC §9.1 scoring math reads a single per-source authority
  today. A future ADR can subdivide.
- *Manual operator override.* "Trust the seed values forever, let
  Simon override via SQL when he disagrees." Rejected as outside the
  SPEC §14 intent — the whole point of the feedback loop is that the
  system learns from accumulated decisions without Simon hand-tuning.

## Consequences

- **New code:** `src/scheduler/recalibrate.ts` exports `runRecalibration(db, opts?)`
  (pure function — useful for tests, scripts, ad-hoc runs) and
  `startRecalibrationCron(db)` (returns a `{task, runOnce, stop}` handle
  for the worker boot path).
- **Schema:** `migrations/015_recalibrate_kind_and_calibration.sql`:
  - Drops + re-adds `runs_kind_check` to allow `'recalibrate'`.
  - Adds `sources.authority_score_seed INT NOT NULL` (backfilled from
    `authority_score` at migration time).
  - Adds `sources.authority_score_calibrated_at TIMESTAMPTZ` (NULL until
    the first cron tick stamps it).
- **Wiring:** `src/workers/ingestion.ts:main()` calls
  `startRecalibrationCron(db)` alongside `startScheduler`, and stops
  the handle in the SIGTERM/SIGINT shutdown path before the DB handle
  closes.
- **Operator surface:** the Obs-1 `/status` endpoint already returns
  the most recent `runs` row in its `last_run` field — that picks up
  `kind='recalibrate'` rows for free. Telegram `/status` likewise.
  ops-digest polling `/status` will see recalibration as a visible
  run-history entry.
- **Insertion path update:** `src/mcp/tools/sources.ts:add_influencer`
  now writes `authority_score_seed = authority_score` at insertion.
  Other source-insertion paths are SQL migrations
  (`002_seed_sources.sql`, `010_seed_sources_coverage.sql`,
  `003_seed_competitors.sql`) which run pre-deploy and were backfilled
  by migration 015 in the same transaction. No further INSERT-site
  audit pending — `tests/db/schema.test.ts` exercises one
  drizzle-level insert into `sources` and is updated to provide the
  seed.
- **Env config:** Two new env vars in `.env.example`:
  `RECALIBRATE_CRON` and `RECALIBRATE_PRIOR_STRENGTH`. Both have safe
  defaults so no operator action is required on deploy.
- **v2 refinement deferred:** time-decayed weighting (see Alternatives
  above) and per-domain calibration. Re-evaluation trigger: if
  post-launch metrics show the 30-day window failing to recognise a
  source whose pick rate has materially shifted in the last week
  (observable by comparing the 7-day rolling pick rate against the
  30-day rolling pick rate per source — both queryable from
  `feedback`), revisit.

## References

- SPEC §6.1 (sources schema + authority_score), §8 (per-domain config
  + authority weighting), §9.1 (cluster scoring math), §10.2 (feedback
  + record_pick), §14 (feedback loop — the "continuous recalibration"
  brief this ADR operationalises)
- ADR-011 / ADR-012 — committed to forward-observation regime;
  ADR-012's closing note explicitly defers recalibration to "Phase 5
  PR 3 (observability)" which this ADR implements as Obs-3
- ADR-007 — the "provisional v1 with re-eval trigger" pattern this
  ADR mirrors (running mean → recentroiding; fixed window →
  time-decay)
- `src/scoring/exclusive.ts` — Stage 4 consumer of `authority_score`
  (the `MIN_AUTHORITY = 75` exclusive threshold) — confirms the
  recalibration target is the live consumer column
- `src/scoring/heuristic.ts` — Stage 3 consumer of `authority_score`
  via the authority-sum + diversity weighting
- Obs-1 PR (#77) — landed `buildStatus` / `GET /status` whose
  `last_run` surface naturally renders recalibration runs without
  further code changes
- `migrations/002_seed_sources.sql`, `migrations/010_seed_sources_coverage.sql`,
  `src/mcp/tools/sources.ts` — the insertion paths whose seed values
  anchor the prior
