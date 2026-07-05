-- 018: candidate supersede (feed redesign P0.1,
-- docs/redesign/2026-07-05-ideation-redesign.md §6).
--
-- The pre-supersede pipeline re-minted a fresh status='new' candidate
-- row for a persisting cluster on EVERY run — the same story showed up
-- 4-5x across /today, RSS, and MCP search (docs/handoffs/2026-06-05.md
-- Open Question 2). From this migration on, the orchestrator UPDATEs
-- the existing 'new' row in place; these columns record the refresh.

ALTER TABLE candidates ADD COLUMN updated_at TIMESTAMPTZ;
ALTER TABLE candidates ADD COLUMN runs_seen INTEGER NOT NULL DEFAULT 1;

-- One-time cleanup of the accumulated duplicates: keep the newest
-- 'new' row per cluster, expire the rest. 'expired' (not DELETE) so
-- decision history joins and feed GUID permanence stay intact.
UPDATE candidates SET status = 'expired'
WHERE status = 'new'
  AND id NOT IN (
    SELECT DISTINCT ON (cluster_id) id
    FROM candidates
    WHERE status = 'new'
    ORDER BY cluster_id, created_at DESC
  );

-- Backstop: the orchestrator's advisory lock (PR #110) already
-- serialises runs, so this index is a schema-level guarantee that the
-- duplicate bug cannot silently return.
CREATE UNIQUE INDEX idx_candidates_cluster_new
  ON candidates (cluster_id) WHERE status = 'new';
