-- 020: honor pre-018 decisions (codex review on PR #155, P1 finding).
--
-- Migration 018's cleanup collapsed duplicate 'new' rows per cluster,
-- but left the case where a cluster carries an unexpired picked/passed
-- row AND a later 'new' duplicate from the old re-mint bug: the
-- duplicate kept the already-decided story alive in /today, RSS, and
-- MCP until its own expiry. Retire those duplicates. The runtime path
-- (upsertCandidate) now does the same whenever such a cluster
-- re-qualifies; this sweep covers clusters that never re-qualify.

UPDATE candidates c
SET status = 'expired', updated_at = NOW()
WHERE c.status = 'new'
  AND EXISTS (
    SELECT 1
    FROM candidates d
    WHERE d.cluster_id = c.cluster_id
      AND d.status IN ('picked', 'passed')
      AND d.expires_at > NOW()
  );
