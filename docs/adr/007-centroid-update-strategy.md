# ADR-007: Centroid update strategy for clusters

- **Status:** accepted
- **Date:** 2026-05-15
- **Resolves:** SPEC §19 Open Q5

## Context

SPEC §7.4 describes clustering: for each new item we find the nearest active
cluster in the same `primary_domain` within a 7-day window and either join
(updating the centroid) or create a new cluster. The open question (§19 Q5)
is HOW the centroid is updated when a new member joins:

- **Running mean** — `centroid' = (centroid * n + new_vec) / (n + 1)` on
  every join, where `n` is the cluster's current `item_count`. A single
  SQL UPDATE; no member re-read required.
- **Periodic re-centroiding** — leave the centroid stale during the day,
  then recompute it as the true mean over member-item embeddings:
  `SELECT AVG(embedding) FROM items WHERE cluster_id = $1`. More accurate;
  more expensive in I/O.

The trade-off matters because clustering quality propagates downstream. A
drifting centroid raises false-negative join rates ("looks like a new
cluster, isn't"), which fragments a single story into multiple clusters,
which degrades Stage 3 cluster scoring (item count, source diversity,
authority sum per SPEC §9.1) and Stage 4 cluster summarisation (one real
story shows up as multiple weak candidates to Simon).

## Decision

**Online updates use the running mean**, computed in JS inside a
`SELECT … FOR UPDATE` transaction. **No periodic re-centroiding in v1.**

Compaction (SPEC §7.4 step 4) merges clusters whose centroids drift close
to each other within the same domain. The merge produces an
item-count-weighted mean of the two existing centroids, computed the same
way (read both, compute in JS inside a transaction with both rows locked,
write back). Compaction does NOT recompute centroids from member items —
the weighted mean preserves the running-mean invariant assuming both
inputs were built that way.

## Rationale

**Why running mean is enough for v1:**

1. **Embedding stability.** `text-embedding-3-small` is a fixed model
   (no fine-tuning, no online retraining), so the only "drift" is numerical
   from successive averaging, not semantic.
2. **Cluster size in practice.** The 7-day window bounds cluster size. Even
   very active stories across Socialisn2's ~hundreds of sources rarely
   exceed 30–50 items per cluster. For unit-norm vectors, the running mean
   deviates from the true mean by O(1/n) — typically &lt;0.01 cosine —
   well below the 0.30 join threshold and the 0.15 compaction threshold.
3. **Cost of re-centroiding.** One `SELECT AVG(embedding)` per active
   cluster per day is individually cheap, but at hundreds of active
   clusters it adds I/O and complicates the compaction job's transactional
   shape for no measurable v1 quality gain.
4. **Detectability.** If running-mean drift IS a problem in production, the
   symptom is fragmented clusters — multiple weak candidates per real
   story, falling Stage 4 cluster quality, and Simon picking less. All
   three are observable from the `candidates` and `feedback` tables.

**Why the math is done in JS, not in SQL:**

pgvector defines only vector-vector arithmetic — `vector + vector`,
`vector - vector`, and (since 0.5.0) element-wise `vector * vector`.
It does **not** define `vector * float` or `vector / float` at any
version through current. The seemingly natural SQL form
`(centroid * n + new) / (n + 1)` does not compile against pgvector;
PostgreSQL responds with `operator does not exist: vector * double
precision`.

The two viable workarounds in SQL — (a) fan a scalar into a same-shape
vector via `array_fill(s, ARRAY[1536])::vector(1536)` and use
element-wise `*` for the multiplications + a pre-computed reciprocal for
the divisions, or (b) restructure to `AVG(embedding)` over the items
table (pgvector ≥0.7) — both have meaningful drawbacks:

- (a) is verbose and has a subtle `real` vs `float` precision boundary at
  the `array_fill` cast that's easy to get wrong.
- (b) requires the item to be inserted into `items` before the cluster
  centroid update, which couples this module to the caller's insertion
  order and inverts the natural pipeline ("normalise → cluster → write
  item" becomes "normalise → write item → cluster").

JS-side read-modify-write inside a `SELECT … FOR UPDATE` transaction is
the simpler shape:

- **Atomicity.** The row lock acquired by `FOR UPDATE` holds for the
  duration of the transaction, closing the SELECT/compute/UPDATE race.
- **Code reuse.** The same shape applies to compaction merges, which
  also need to fetch both centroids to compute the weighted mean —
  pgvector can't do the merge in pure SQL either, so we'd need this
  path regardless.
- **Cost.** One extra round-trip per join (1536 floats ≈ 6 KB on the
  wire). Embedding API latency dominates the pipeline at hundreds of
  milliseconds; the centroid round-trip is in the noise.

pgvector ≥0.5.0 (the version implied by the schema's HNSW index usage)
remains the floor; nothing in this PR pushes that requirement higher.

## Consequences

- `src/scoring/cluster.ts` exposes `assignCluster(db, input, opts)` that
  performs find-or-create. The match path opens a transaction, locks the
  matched cluster row with `FOR UPDATE`, computes the new centroid in JS
  via `(centroid * n + new_vec) / (n + 1)`, and writes it back.
- The same module exposes `compactClusters(db, opts)` for the daily
  compaction job (SPEC §7.4 step 4). Each merge opens a transaction,
  locks both cluster rows (in stable id order to avoid deadlocks),
  computes the item-count-weighted mean in JS, then UPDATEs target +
  items + source. Compaction does NOT recentroid from members; the
  weighted mean preserves the running-mean invariant.
- Compaction consumes BOTH sides of each merge for the remainder of the
  pass. A target whose centroid has just moved must not be re-merged
  using a precomputed distance — chained merges across three or more
  clusters are deferred to subsequent daily passes, which is acceptable
  at the daily cadence. The worst case is a "true triangle" of three
  same-story clusters taking ~3 days to fully collapse, never producing
  a wrong merge.
- The compaction job runs daily at 03:00 ET per SPEC §7.4. The cron
  schedule is wired in Phase 4 PR 4 (run orchestration); this PR ships
  only the function and a manual entry point at
  `scripts/compact-clusters.ts`.
- Re-centroiding is a v1.1 candidate. **Trigger condition:** if
  post-launch metrics show ≥20% of "new" clusters per day having a
  cosine distance &lt;0.20 to some existing cluster in the same domain
  over a sustained week (obvious fragmentation), revisit. The
  recentroid-from-members SQL is:
  ```sql
  UPDATE clusters c
  SET centroid = sub.mean
  FROM (
    SELECT cluster_id, AVG(embedding) AS mean
    FROM items
    WHERE cluster_id = ANY($1::uuid[])
    GROUP BY cluster_id
  ) sub
  WHERE c.id = sub.cluster_id;
  ```
  (pgvector ≥0.7 supports `AVG(vector)`. If we're still on 0.5 or 0.6 at
  the time, fall back to computing the mean in app code per cluster.)

## References

- SPEC §7.4 (clustering), §8 (per-domain config), §9.1 (cluster scoring),
  §19 Q5
- pgvector arithmetic operators:
  https://github.com/pgvector/pgvector#vector-operators
- ADR-006 (whisper model size) for the "provisional with re-eval trigger"
  pattern this ADR mirrors for v1.1
