# ADR-005: GDELT rate-limit fallback strategy

- **Status:** accepted
- **Date:** 2026-05-13
- **Resolves:** SPEC §19 Open Q3 (GDELT rate-limit fallback threshold)

## Context

GDELT 2.0 GKG is the enrichment layer for clustered candidates per SPEC §6.8 — queried *after* a cluster is formed, never to find candidates. The free GKG DOC API has no published quota, but is observed in practice to have soft rate limits: returns slow under load, occasional 5xx, occasional truncated payloads. Industrial alternative is GDELT 2.0 BigQuery exports — same data, free up to GCP free-tier limits, requires a GCP project + service-account auth + a cron loader.

The question: when do we wire the BigQuery fallback?

## Decision

**v1 uses GKG DOC API only with a 6-hour per-query cache. No automatic BigQuery fallback.**

Threshold for *manually* moving to BigQuery (i.e. promoting Q3 from "deferred" to "build it"):

- ≥ 2 rate-limited responses (HTTP 429, 5xx, or response truncation) per cluster in a 24-hour window, OR
- p95 GKG fetch latency > 30 seconds sustained for 1 hour, OR
- > 5% of `gdelt_coverage.fetched_at` rows in the last 7 days are NULL (indicating consistent failure)

Until any threshold is breached, v1 stays on GKG.

## Rationale

### Why GKG-only is enough for v1 in expectation

- Traffic profile is *very* low. The 6-hour cache plus ≤ 100 candidates/run means at worst ~ten unique GKG queries per day. GKG handles that without strain.
- The `gdelt_coverage` cache row encodes `query_hash` (sha256 of normalised query + date window). Repeat queries within 6 h cost zero API calls. Phase 3 scoring may invoke `lookupOrFetchCoverage` from multiple ranking stages on the same cluster; the cache absorbs that fan-in.
- A failed GKG call doesn't break scoring — `is_exclusive`, `temperature`, and the geographic-spread bonus all have well-defined fallback values when coverage is null (per SPEC §9.5 / §9.6). Failures degrade signal, they don't crash the pipeline.

### Why not pre-emptive BigQuery

BigQuery setup is non-trivial:

- A dedicated GCP project (and a billing account, even though GDELT queries themselves stay in the free tier — GCP requires billing-enabled to use BigQuery, with a strict cap workflow if you want zero-spend).
- Service-account auth + secret management (a third credential alongside `LITELLM_API_KEY` and `OPENAI_API_KEY`).
- A separate loader process (cron-driven, downloads & parses GDELT 2.0 exports — files are ~100 MB / 15 min).
- Storage decisions for raw exports (S3 / R2 / local disk?).

That's ~1 person-week of engineering vs the marginal benefit of "have a fallback ready before we know we need it." Defer until the data tells us we need it.

### Why the threshold isn't "first 429"

A single 429 in 24 h is well within transient-failure budget — the BullMQ retry handles it (3 attempts, exponential backoff). The trigger is *patterned* failure, not isolated. Two-plus-per-day means GKG is consistently struggling at the volume we're sending; that's when investment in the fallback pays off.

## Consequences

- `src/ingestion/gdelt.ts` does **not** import any BigQuery client in v1. The adapter's only outbound dependency is the GKG DOC HTTP endpoint.
- Rate-limit / failure events are surfaced via:
  - Throwing on non-OK HTTP responses (caller decides whether to retry or write a null-coverage row)
  - `runs.metadata.gdelt_errors[]` aggregated at scoring time so the daily run summary shows the count (wired in Phase 3 PR 4)
- `gdelt_coverage.fetched_at IS NULL` is reserved for "we tried and failed" rows; the lookup helper writes a real `fetched_at` only on success. v2 monitoring keys off this column.
- When the threshold trips, the v2 BigQuery loader lands as a *parallel* writer to `gdelt_coverage` (same schema). The cache lookup helper does not need to know which writer populated a row.

## References

- SPEC §6.8 (GDELT enrichment layer)
- SPEC §7.1 (GDELT cron cadence — on-demand per cluster, cached 6h)
- SPEC §9.5 (`geographic_spread_bonus` depends on GDELT)
- SPEC §19 Open Q3 (this ADR's resolution target)
- BUILD-PHASES.md Phase 1 PR 3 / Phase 3 PR 2 (adapter lands here; first caller is the heuristic-ranking stage)
