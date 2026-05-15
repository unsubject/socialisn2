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

**Online updates use the running mean** via a single SQL UPDATE with
pgvector arithmetic. **No periodic re-centroiding in v1.**

Compaction (SPEC §7.4 step 4) merges clusters whose centroids drift close
to each other within the same domain, but it does NOT recompute centroids
from members either. The merge produces an item-count-weighted mean of the
two existing centroids — mathematically the running mean of all members,
assuming both were built that way.

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

**Why the running mean is implemented in SQL, not application code:**

- **Atomicity.** A single UPDATE is row-atomic — no SELECT/UPDATE race, no
  need for `SELECT FOR UPDATE` or an explicit transaction. Phase 5 may run
  multiple scoring workers; the SQL approach is forward-compatible without
  rework.
- **One round-trip per join.** No 1536-dim float array crossed over the
  wire per item. The current Phase 2 single-worker case doesn't care, but
  the read-modify-write alternative becomes expensive once the pipeline
  scales.
- **Compaction shape generalises.** The same operator pattern
  `(a * n_a + b * n_b) / (n_a + n_b)` is reused in the compaction merge —
  one mental model, one set of guarantees.

pgvector ≥0.5.0 exposes `vector * float`, `vector + vector`, and
`vector / float` as native operators. The repo's schema uses HNSW
indices on `clusters.centroid` and `items.embedding`, which require
pgvector ≥0.5.0, so the dependency is already in place.

## Consequences

- `src/scoring/cluster.ts` exposes `assignCluster(db, input, opts)` that
  performs find-or-create with the running-mean update in one UPDATE.
- The same module exposes `compactClusters(db, opts)` for the daily
  compaction job (SPEC §7.4 step 4). Compaction does NOT recentroid; it
  produces a weighted-mean merge that preserves the running-mean
  invariant.
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
