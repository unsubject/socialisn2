# Phase 2 — Normalisation & clustering

**Status:** complete (PRs landed 2026-05-13 → 2026-05-16)

Phase 2 closes the cheap end of the scoring pipeline: `raw_items` get a
neutral English summary + embedding, items are clustered against existing
centroids, and near-duplicates are caught before they materialise as new
`items` rows. The LLM and ranking stages (Sonnet curate, archive overlap,
temperature, trajectory) live in Phase 3.

## PRs landed

| PR | What |
|---|---|
| #34 | LLM + embedding plumbing — `src/lib/{llm,embeddings}.ts`, `src/cost/{ledger,pricing}.ts`, env additions, ADR-006 (Whisper) |
| #35 | Normalisation — `src/scoring/normalize.ts`, `config/prompts/normalize.txt`, migration 009 (`items.keywords text[]`) |
| #42 | Clustering — `src/scoring/cluster.ts` (`assignCluster` + `compactClusters`), `scripts/compact-clusters.ts`, ADR-007 (centroid update strategy) |
| #43 | Semantic dedup — `src/scoring/semantic-dedup.ts` (SPEC §7.2 step 2 at cosine ≥ 0.93) |

## Decisions

- **ADR-006 — Whisper model size for Cantonese.** Provisional commitment
  to `large-v3` via `faster-whisper` INT8. Decision is reaffirm-or-revise
  at Phase 6 PR 1 against a real Cantonese audio sample — no benchmark
  was available at Phase 2 PR 1 and blocking the rest of Phase 2 on an
  audio sourcing was the wrong trade.
- **ADR-007 — Centroid update strategy.** Running mean computed in JS
  inside a `SELECT … FOR UPDATE` transaction, no periodic re-centroiding
  in v1. The SQL form `(centroid * n + new) / (n + 1)` does not compile —
  pgvector exposes only vector-vector arithmetic, not scalar. ADR documents
  a measurable trigger for revisiting in v1.1.

## Carry-overs (intentionally deferred)

- **Per-domain thresholds (SPEC §8).** `assignCluster`,
  `compactClusters`, and `findSemanticDuplicate` all expose a
  `threshold` / `similarityThreshold` function arg with the SPEC §7
  default baked in. Phase 3 PR 3 loads the per-domain table via
  `config/domains.ts` and passes overrides at call sites; no further
  changes to these modules are needed.
- **Compaction cron.** `compactClusters` runs through
  `scripts/compact-clusters.ts` as a manual entry point. The 03:00 ET
  cron lands in Phase 4 PR 4 alongside the other output crons.
- **End-to-end orchestration.** `normalize → embed → semantic-dedup →
  cluster` has no driver yet. Phase 3 PR 4 wires the morning /
  afternoon `runs` row and threads `run_id` / `stage` through
  `recordCost` for per-stage cost attribution.
- **`stripBoilerplate` first-line guard** (carried from Phase 1 PR 4
  review). A real newsletter starting with `"View this email in your
  browser"` would currently cut the entire body. Needs a "marker must
  appear after first N non-empty lines" guard.

## Cost & throughput

Not yet measurable end-to-end — the orchestrator that writes a `runs`
row and triggers all of Stage 0-2 in one pass lands in Phase 3 PR 4.
The per-stage cost-attribution wiring (`recordCost(run_id, stage)`) is
already in place from PR #34, so the Phase 3 phase report will be the
first one with concrete USD-per-stage numbers.

## Open risks

- **No real-audio benchmark for Whisper** yet (ADR-006). Phase 6 PR 1
  re-evaluates against Simon's competitor channel set.
- **Dedup window anchors on `published_at` vs `NOW()`.** A backfill
  pass that rehydrates items with old `published_at` values would not
  participate in the 7-day dedup window. Acceptable for v1 — backfill
  is a one-shot Phase 5 PR 1 task; the steady-state pipeline only sees
  fresh `published_at` values.
- **HNSW recall at small N.** `items.embedding` and `clusters.centroid`
  are indexed with HNSW (approximate). In the integration tests we keep
  all candidate pairs inside the recall envelope by construction; at
  production scale with thousands of items per domain, `ORDER BY <=>`
  may miss the true nearest. Mitigation deferred until measurable.
- **Compaction is O(N²)** within a domain at the candidate-query stage.
  With <100 active clusters per domain in the 7-day window, fine.
  Phase 5 can revisit if profiling flags it.

## What ships next

Phase 3 PR 1 — `src/lib/two_brain_client.ts` (calls `archive_search` /
`record_pick` on the 2nd-brain MCP, graceful fallback per SPEC §10.2) +
**ADR-008** (headline language for candidates — resolves SPEC §19 Open
Q6).
