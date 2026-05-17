-- 011_raw_items_processing.sql
-- Adds processing-state tracking to raw_items so the continuous Phase 2
-- worker (src/workers/scoring.ts) can poll for pending rows and so
-- SPEC §7.2 step 2 dedup-hits have a place to record the cluster they
-- were merged into without inserting an items row.
--
-- Also: a UNIQUE index on items.raw_item_id. v1 runs a single
-- scoring-worker process so the race is theoretical, but the cheapest
-- way to guarantee "at most one items row per raw_item" forever is to
-- let the schema enforce it. A two-worker race becomes a benign
-- losing-side rollback + retry instead of a silent double-insert.
--
-- State machine for a raw_item:
--   pending           → processed_at IS NULL AND processing_attempts < N
--   normal-processed  → processed_at IS NOT NULL AND an items row exists
--                       with raw_item_id = this.id (cluster_id read from
--                       items.cluster_id)
--   dedup-hit         → processed_at IS NOT NULL AND no items row points
--                       back. dedup_cluster_id is usually set to the
--                       cluster the matched items row belonged to, but
--                       MAY be NULL when the matched item was itself
--                       unclustered (items.cluster_id is nullable —
--                       defensive, never expected in v1's scoring path).
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

-- One items row per raw_item, max. See header for the rationale; FK
-- constraints don't auto-create indexes in PG, so this also provides the
-- per-raw_item lookup index we'd want anyway for triage queries
-- ("which items row corresponds to this raw_item?").
CREATE UNIQUE INDEX items_raw_item_id_unique ON items (raw_item_id);
