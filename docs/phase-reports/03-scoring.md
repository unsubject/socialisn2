# Phase 3 — Scoring & Curation: Phase Report

**Status:** complete — four PRs landed.
**Date:** 2026-05-16.
**Scope:** SPEC §9 (scoring engine) + §10 (2nd-brain integration) +
§12 cost ceiling enforcement.

## What shipped

| PR | SHA | What |
|---|---|---|
| #50 | `ee4b5e7` | Phase 3 PR 1 — 2nd-brain MCP client (`src/lib/two_brain_client.ts`) + ADR-008 (headline language). Bearer-authed JSON-RPC 2.0 with Streamable HTTP `text/event-stream` support. SPEC §10.2 graceful fallback: 3× exponential backoff on transient errors, fail-fast on permanent 4xx / RPC -32601/-32602, degraded `[]` / `{ok:false}` at the public surface. |
| #51 | `426affb` | Phase 3 PR 2 — five scoring modules: `archive.ts` (§9.3 overlap + drop/flag), `temperature.ts` (§9.5 z-score with Poisson floor), `trajectory.ts` (§9.5 24h derivative), `exclusive.ts` (§6.1 first-publisher), `heuristic.ts` (§9.1 ranking + top-N). No schema changes; every signal projects into existing `candidates` columns at Stage 7. |
| #52 | `06743c2` | Phase 3 PR 3 — `src/scoring/curate.ts` (Sonnet curation), `src/cost/ceiling.ts` (§12 hard halt), `config/positioning.md` (verbatim from SPEC), `config/domains.ts` (§8 per-domain table + recencyDecay), `config/tags.ts` (controlled vocabulary), `config/prompts/{headline,curate}.txt`. |
| #53 | _this PR_ | Phase 3 PR 4 — `src/scoring/headline.ts` (Stage 4 summarisation) + `src/orchestrator/run.ts` (Stages 3-7 orchestrator) + phase report. End-to-end scoring pipeline runnable against a real PG + stubbed LLM/MCP via dependency injection. |

## Key decisions made and why

1. **Pure-function modules + DI orchestrator.** Every scoring module
   (`archive`, `temperature`, `trajectory`, `exclusive`, `heuristic`,
   `headline`, `curate`) is a pure transformation that takes inputs
   and returns outputs — they do not read or write the database. The
   orchestrator (`run.ts`) is the one place that touches `clusters`,
   `items`, `candidates`, `cost_ledger`, `runs`. This isolates the
   schema-coupling to a single file and makes every other module
   unit-testable without Postgres. The three external calls
   (Stage 4 Gemini, Stage 5 MCP, Stage 6 Sonnet) are injected as
   dependencies so the orchestrator test runs without LiteLLM /
   2nd-brain.

2. **No schema changes in Phase 3.** Every signal computed (temperature,
   trajectory, is_exclusive, exclusive_source_id, archive_overlap,
   archive_overlap_links, curation_score, curation_rationale,
   keywords, tags) projects into existing `candidates` columns already
   defined in migration 001. The Phase 2 schema was forward-designed
   for this stage.

3. **Cost ceiling halts the run, not the process.** SPEC §12 says
   "partial candidates are still persisted". `assertWithinCeiling`
   throws `CostCeilingHitError`; the orchestrator catches it inside
   the per-cluster loop, breaks, and marks the run
   `status='completed' + error='cost_ceiling_hit'` so /status surfaces
   the halt without treating it as a runtime failure. Candidates
   already inserted (clusters 1 to N-1) remain.

4. **Conservative per-call cost projections.** The ceiling check uses
   pessimistic upper bounds (Gemini = $0.001, Sonnet = $0.008) so a
   single under-projected call cannot sneak past an exact-ceiling
   check. Real cost is recorded post-call from the LiteLLM response.

5. **JSON-RPC + dual Accept (`application/json, text/event-stream`)
   per the MCP Streamable HTTP spec.** 2nd-brain's own mcp-worker
   doesn't enforce this, but SDK-based servers 406 without it. We
   send both and parse either response shape, so the same client
   works against any compliant MCP server.

6. **Poisson stddev floor for temperature.** A quiet domain where
   every other cluster has identical `item_count` gives observed
   `STDDEV = 0`. Without a floor, a runaway cluster silently labels
   as `warm`. We use `effectiveStddev = max(observed, sqrt(max(mean, 1)))`
   — the natural Poisson lower bound for count data.

7. **Source-language headlines (ADR-008).** Headlines preserve the
   underlying source language (English, Traditional Chinese, etc).
   `summary_en` (from normalise) is the consistent English handle for
   downstream stages. Re-evaluation trigger: Phase 5 PR 4 pilot if
   Simon reports headline-scanning bottleneck.

## Tried and abandoned

- **Calling `archive_search` against the existing `search_brain`
  tool.** 2nd-brain's MCP exposes `search_brain` / `get_entry` /
  `list_recent` / `save_session`, not the `archive_search` /
  `record_pick` SPEC §10.1 specifies. We considered mapping the
  socialisn2 client onto `search_brain` to get a live integration
  immediately. Rejected because `search_brain` works on journal
  entries (private thoughts), not on the essay/episode archive
  socialisn2 needs to dedup against. Wrong corpus. Instead: we
  ship the client against the SPEC names and rely on the SPEC §10.2
  graceful fallback (returns `[]`, scoring proceeds with
  `archive_overlap=0`) until 2nd-brain exposes the tools. Build task
  added on the 2nd-brain side.

- **Stage 3 heuristic ranking via SQL aggregate.** Considered
  computing the heuristic score in a single window-function query
  over clusters × items × sources × gdelt_coverage. Rejected because
  the per-domain weight + the Poisson stddev floor + the per-cluster
  exclusive detection don't compose cleanly in SQL, and the per-pass
  cluster count (~hundreds) makes the JS-side loop fast enough.

- **Whole-run transaction.** Rejected for the same reason cluster.ts
  uses one tx per merge: a crash mid-run should leave the partial
  state stable enough for the next run to pick up cleanly, not roll
  back a thousand candidate inserts.

## Open questions

- **Continuous normalise/cluster worker isn't yet wired.** The Phase 2
  modules (`normalize.ts`, `embeddings.ts`, `semantic-dedup.ts`,
  `cluster.ts`) exist and are unit-tested but nothing drives them on
  every `raw_items` insert. The current `scoring-worker` in
  docker-compose is still a placeholder. The orchestrator built in
  this PR assumes `items` and `clusters` are pre-populated; for the
  Phase 5 deploy to do anything, a continuous worker that processes
  unprocessed `raw_items` into `items + clusters` must land first.
  **Not in scope for Phase 3; lands as Phase 3.5 or Phase 5 PR 0.**

- **Cron + worker entry point.** BUILD-PHASES PR 4 mentions
  "cron-triggered morning / afternoon runs". The runScoring function
  is the editorially complete unit; the actual cron wiring
  (`node-cron` schedule, `scoring-worker.ts` BullMQ entry) is
  deployment glue that's natural to land alongside Phase 5 PR 2
  (VPS deploy script). Argued explicitly because BUILD-PHASES could
  read either way — I picked the smaller PR.

- **GDELT `gdelt_coverage` population is not yet wired.** Phase 1 PR
  3 shipped the GDELT ingestion adapter but the orchestrator's
  geographic-spread-bonus lookup assumes `gdelt_coverage` rows exist
  per cluster. Today the table is empty so every cluster's geo bonus
  is 0. Lands in Phase 5 PR 1 (backfill) or earlier if needed.

- **Domain decay for `expires_at`.** SPEC §9.6 says "compute from
  domain decay". v1 here picks the half-life as the expiry point
  (matches the SPEC's example "economy: NOW + 48h" which is exactly
  the half-life). The other interpretations — NOW + 2×half-life
  (decay to 25%), or until the recency-decay weight drops below a
  fixed floor — are equally defensible. Revisit at Phase 4 PR 1 when
  the RSS surface starts surfacing expiry to consumers.

## What's intentionally NOT in this PR

- Continuous normalise/cluster worker (see Open questions).
- Cron scheduler + worker entry point (Phase 5 PR 2).
- GDELT coverage population (Phase 5 PR 1).
- Authority recalibration loop (Phase 5 PR 1 backfill territory).
- The actual `archive_search` + `record_pick` tools on the 2nd-brain
  MCP side (Build task on `unsubject/2nd-brain`).

## Branch state at phase close

- `main` at this PR's merge sha.
- Worktree branches `phase3-pr1-two-brain-client`,
  `phase3-pr2-heuristic-ranking`, `phase3-pr3-curation`, and
  `phase3-pr4-orchestrator` deleted post-merge.
- Next: Phase 4 PR 1 (RSS feed generation) per BUILD-PHASES.
