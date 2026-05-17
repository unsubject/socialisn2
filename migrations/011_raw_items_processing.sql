-- 011_raw_items_processing.sql
-- Adds processing-state tracking to raw_items so the continuous Phase 2
-- worker (src/workers/scoring.ts) can poll for pending rows and so
-- SPEC §7.2 step 2 dedup-hits have a place to record the cluster they
-- were merged into without inserting an items row.
--
-- State machine for a raw_item:
--   pending           → processed_at IS NULL AND processing_attempts < N
--   normal-processed  → processed_at IS NOT NULL AND an items row exists
--                       with raw_item_id = this.id (cluster_id read from
--                       items.cluster_id)
--   dedup-hit         → processed_at IS NOT NULL AND dedup_cluster_id
--                       IS NOT NULL AND no items row points back
--                       (the raw_item was near-duplicate of an existing
--                        items row at cosine ≥ 0.93 per SPEC §7.2 step 2)
--   poisoned          → processed_at IS NULL AND
--                       processing_attempts >= MAX_PROCESSING_ATTEMPTS
--                       (worker has stopped retrying; manual triage needed)
--
-- dedup_cluster_id is deliberately named distinctly from items.cluster_id
-- to avoid a "two cluster_ids in the same query" trap at review time —
-- the column ONLY carries the dedup-hit cluster, not the normal-path
-- one. The normal path keeps cluster_id on items where downstream
-- aggregations already live.

ALTER TABLE raw_items
  ADD COLUMN processed_at        TIMESTAMPTZ,
  ADD COLUMN dedup_cluster_id    UUID REFERENCES clusters(id),
  ADD COLUMN processing_attempts INT NOT NULL DEFAULT 0;

-- Polling index — partial so it stays tiny once the bulk of the table
-- is processed (the steady-state hot set is just the in-flight tail).
CREATE INDEX idx_raw_items_pending
  ON raw_items (fetched_at)
  WHERE processed_at IS NULL;
