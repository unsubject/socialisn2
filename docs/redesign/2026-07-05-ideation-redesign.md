# Feed Redesign: From Firehose to Editorial Desk

**Date:** 2026-07-05
**Status:** Approved 2026-07-05 (Simon) — RSS-first delivery (§8). P0 shipped (#155, #156). P1 (Weekly Ideation Brief) shipped. P2 (collision detector) next.
**Supersedes:** SPEC.md §11 (delivery) and the "no thesis, no angle" boundary in SPEC.md §2;
SPEC.md gets amended once this is approved.

## 1. Why

One month of live use (mid-May → early July). Verdict from the operator: *"a firehose of
feeds that doesn't really help me in ideation."* The pipeline itself (ingest → embed →
cluster → curate) is healthy after the May hardening campaign; the failure is in what gets
delivered, in what unit, at what volume.

## 2. Interview record (2026-07-05)

| # | Question | Answer |
|---|----------|--------|
| 1 | What does ideation success look like? | **A+B+C** — an episode-worthy *angle*; a *cross-domain collision* (bisociation raw material); *early signal on a wave* |
| 2 | Which failure hurts most? | **A+B+C** — volume + repeats; items-not-angles; best stuff buried. Notably **not D** (taste model) |
| 3 | Ideal consumption shape? | **C** — thin daily pulse + weekly deep synthesis |
| 4 | Cross the "no thesis, no angle" line? | **A** — fully: top candidates arrive as episode pitches |

Read together: the daily surface should shrink to a **radar** (wave detection, exclusives,
a handful of ranked headlines), and the actual ideation product becomes a **weekly brief**
built of episode pitches — hook, dialectical angle, why-now, evidence — plus deliberately
engineered cross-domain collisions. Questions 5–8 (surface, taste loop, domain balance,
daily number) are answered with assumed defaults in §8, flagged for confirmation.

## 3. Diagnosis — why it firehoses (all confirmed in code)

1. **No output cap.** The only gate between curation and the user is
   `curation_score >= 60` (`src/orchestrator/run.ts:107`). A real run minted ~147
   candidates (comment at `run.ts:314`); two runs/day makes ~300/day spec-legal. SPEC
   promised "a small ranked pool" (SPEC.md:18) and never quantified "small."
2. **Cross-run duplication bug.** A persisting story re-mints a fresh `status='new'`
   candidate row every run — there is no `UPDATE candidates` anywhere. Same story seen
   4–5× (docs/handoffs/2026-06-05.md Open Q2; ranked "highest value" in 2026-06-05-pm.md).
3. **Nothing the user sees is ranked.** `/today` (`src/telegram/commands/list.ts:90`),
   RSS (`src/rss/generate.ts:176`), and MCP `list_candidates`
   (`src/mcp/tools/candidates.ts:116`) all order by `created_at DESC`. `curation_score`
   is computed, stored, and never used for ordering.
4. **The pool accumulates.** Expiry = 1× domain half-life (economy 48h … economics 14d,
   `config/domains.ts`), so twice-daily inflow meets multi-day outflow.
5. **The digest carries zero decidable information.** "Morning run complete. 4 new in
   `economy`…" — counts only (`src/telegram/format.ts:224-253`). All triage is pushed to
   `/today`, capped at the 30 *newest* (dup-inflated) rows.

Compounding: arXiv floods ~80% of the trending pool with evergreen ML papers
(2026-06-05 handoff); learning is per-source only (ADR-013), never per-topic; pick/pass
`reason` strings are stored and never consumed; the original acceptance test (≥1
pick/day Simon couldn't have found via Perplexity/Google/YouTube) was defined 2026-05-23
and never run.

## 4. Design principles

1. **Attention budget is a hard constraint, not an aspiration.** Push surfaces have
   numeric caps. Persistence can stay generous (the pool feeds weekly synthesis); the
   *push* is budgeted.
2. **The unit of delivery is the angle, not the item.** Crossing SPEC's "not a research
   tool" line by decision 4A. Curation's job ends at "worth your attention *because…*",
   with the *because* stated.
3. **Daily = radar, weekly = ideation.** Waves and exclusives can't wait a week (success
   criterion C); synthesis shouldn't interrupt daily (pain A). Split them.
4. **Serve bisociation explicitly.** Cross-domain collisions are the operator's stated
   raw material — make the system compute candidate collisions instead of hoping a flat
   list triggers them.
5. **Persist everything, push almost nothing.** No data loss vs. today; the DB pool,
   RSS, and MCP remain the deep archive.

## 5. The two new surfaces

### 5.1 Daily Pulse (replaces the digest) — delivered as RSS

Per Simon's Q5 answer (2026-07-05): **RSS is the reading channel, not Telegram.**
The pulse is a new feed, `/feeds/pulse.xml`, and Telegram's scheduled digest push is
disabled by default. Telegram remains the *interaction* channel — `/cand`, pick/pass/
defer buttons — plus (pending Simon's call) the instant ⚡ exclusive push, which is the
one thing an RSS poll cycle is too slow for (success criterion C, early waves).

Each run appends **at most `PULSE_TOP_N = 5` entries** to `pulse.xml` (≤10/day), the
top of the run by `curation_score DESC`. Entry shape:

```
<title>💥📈 US mega-IPO window and the AI capex cliff</title>
<description>
  ↳ Angle: the IPO calendar is a liquidity clock for the AI bubble thesis
  economy · score 84 · rising · 2 more sources since yesterday
</description>
<link>https://…/c/<id></link>   ← existing rendered detail page
```

- **Cap:** 5 per run, ordered by `curation_score DESC`. Not a re-sort of the existing
  50-item feeds — a separate, budgeted feed. The existing `all.xml` + 5 domain feeds
  remain as the deep archive (now score-ranked and deduped via P0.1–2).
- **Angle line:** reuses the already-stored `curation_rationale` (1–2 sentences, written
  by the curate stage since Phase 3) — zero new LLM cost in P0; upgraded to a true
  pitched hook in P1.
- **Waves:** one additional `pulse.xml` entry per morning run — the trending board as a
  single entry, arXiv-suppressed (§6 P0.5), themes only.
- **Afternoon run:** contributes entries only if it produced an exclusive or a new
  `hot`/`rising` wave (Q10). RSS is pull-based, so "silent" here means "adds nothing to
  the feed," keeping pulse.xml thin.
- Everything else stays reachable: `/today` and the archive feeds become score-ranked
  and deduped.

### 5.2 Weekly Ideation Brief (the new product)

New orchestrator job, Sunday 18:00 ET (assumed default), consuming the week's pool:
all candidates (any status) with score ≥ 60, the week's picks/passes *with reasons*,
trending history, 2nd-brain archive themes (client already exists:
`src/lib/two_brain_client.ts`).

Output — 3–5 **episode pitches**:

```
## Pitch: <hook — one dialectical sentence in the channel's voice>
- Wave:      trajectory + timing (why this week, not next month)
- Angle:     thesis → steelman → where the steelman breaks
- Fit:       positioning-statement fit + callback to a past episode when
             archive_overlap lands in the 0.70–0.85 "related" band
             (today that flag is computed and then ignored — it is sequel
             material, not noise)
- Evidence:  3–5 links (cluster sources, papers, primary data)
- Collision: cross-domain rhyme, when the detector (§5.3) found one
```

Delivery: a rendered HTML page (`/brief/:date`, reusing the `src/rss/render-detail.ts`
server-rendering infra) + one weekly entry in a new `/feeds/brief.xml` feed whose
`content:encoded` carries the full brief HTML (RSS-first per Q5). Stored in a new
`briefs` table so past briefs are queryable via MCP. Decisions on pitches still happen
via Telegram/MCP; a P1 nice-to-have is signed one-click pick/pass action links embedded
in the brief HTML so a decision is one tap from the RSS reader.

Model: this is the one call/week where a frontier model is worth it (see §7 cost). The
curate stage's flash-lite economics don't apply — 1 call/week, high stakes.

### 5.3 Collision detector (serves success criterion B directly)

In the weekly job: take the week's cluster centroids, pair across *different*
`primary_domain`s, keep pairs in a similarity "rhyme band" (candidate default
cosine 0.45–0.80 — near enough to rhyme, far enough to be non-obvious; tune from real
distributions), rank top ~20 pairs, and have the brief model judge: *is there a shared
mechanism or structural analogy here, and what's the one-line version of it?* Best 2–3
survive into the brief as collisions or attach to pitches.

This is the feature the operator's bisociation workflow has been missing: the system
holds ~500 clusters/week across five domains — no human scans that cross-product.

## 6. Build phases

### P0 — Stop the bleeding (no new LLM calls, no new products)

1. **Candidate supersede.** In the run.ts persistence step: if a `status='new'`,
   unexpired candidate exists for the same `cluster_id`, UPDATE it (score, summary,
   rationale, `expires_at`, new `updated_at`, increment new `runs_seen`) instead of
   INSERT. Migration: add `updated_at`, `runs_seen`; partial unique index on
   `(cluster_id) WHERE status = 'new'`. Kills the 4–5× repeats at the root.
2. **Rank every surface.** `ORDER BY curation_score DESC, created_at DESC` in
   `src/telegram/commands/list.ts`, `src/rss/generate.ts`, `src/mcp/tools/candidates.ts`.
3. **Pulse feed.** New `/feeds/pulse.xml` per §5.1: top-5 entries per run (angle line
   from `curation_rationale`), plus a morning waves entry. Telegram scheduled digest
   push gated behind `TELEGRAM_DIGEST_ENABLED` (default **false**); the ⚡ exclusive
   instant push stays enabled for now (only remaining push — Simon can veto).
4. **Afternoon quieting.** Afternoon runs contribute pulse entries only when
   (exclusives > 0 OR new hot/rising wave).
5. **arXiv containment.** (a) exclude arXiv-only clusters from the trending keyword pool
   (`src/scoring/trending.ts`); (b) 0.5 heuristic multiplier for clusters whose items
   are all `kind='arxiv'` (`src/scoring/heuristic.ts`) — corroboration by any non-arXiv
   source lifts it. Papers still flow to the weekly brief as evidence.

### P1 — Weekly Ideation Brief

New `src/orchestrator/weekly-brief.ts` + `WEEKLY_BRIEF_CRON` (default `0 18 * * 0` ET),
pitch schema + prompt (extends `config/positioning.md` with the pitch contract), `briefs`
table + migration, Telegram + HTML delivery, `get_brief` MCP tool, new cost sub-bucket.

### P2 — Collision detector

Cross-domain centroid pairing + rhyme-band filter + LLM judging inside the weekly job;
collisions render in the brief. Tunable band; log the distribution for the first two
weeks before trusting it.

### P3 — Taste loop (explicitly deferred)

Pain D wasn't selected: don't build topic-level preference learning yet. Cheap
preparatory step only: the weekly brief prompt already receives pick/pass *reasons*, so
the accumulated `feedback.reason` strings finally get consumed without any new model
machinery. Revisit after 4–6 weeks of brief feedback.

## 7. Cost impact

- P0: zero marginal LLM cost (reuses stored rationale; removes duplicate curation work —
  supersede means re-seen clusters skip nothing today, so cost is flat-to-lower).
- P1+P2: one frontier-model call/week (brief + collision judging in a single context),
  projected ≤ $0.60/run — ~$0.09/day amortised against the $2.20/day ceiling. New
  `weekly` sub-bucket wired through `assertWithinCeiling`.

## 8. Open questions — RESOLVED (Simon, 2026-07-05)

| # | Question | Resolution |
|---|----------|------------|
| Q5 | Primary surface | **RSS, not Telegram** — pulse + brief delivered as feeds; Telegram digest push off by default; Telegram/MCP remain the decision channel |
| Q6 | Taste loop | Deferred (P3) — default accepted; reasons consumed by the brief prompt only |
| Q7 | Domains / arXiv | **Keep all five domains; contain arXiv** (P0.5), don't kill it |
| Q8 | Daily triage number | 5 per run, ≤10/day in pulse.xml — confirmed |
| Q9 | Brief timing | Sunday 18:00 ET — confirmed |
| Q10 | Afternoon pulse | Contributes nothing unless exclusive or new hot wave — confirmed |

## 9. Acceptance criteria

1. Pulse never exceeds 5 items; no story appears twice across a week of pulses.
2. Every pulse item carries an angle line; ordering is by curation score.
3. Weekly brief: ≥1 pitch per week rated "would record" by Simon in the first 3 weeks;
   track pitch→episode conversion via picks + 2nd-brain.
4. Cost: daily ceiling untouched; brief ≤ $0.60/run.
5. Re-run the original, never-run pilot test: ≥1 pick/day Simon wouldn't have found via
   Perplexity/Google/YouTube, measured over 5 days after P1 lands.
