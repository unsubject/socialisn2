-- One-time normalisation: lowercase every sender_map.match_value so the
-- case-folded lookup in email-worker/src/sender-map.ts hits the value
-- writers now store (also lowercased). Email locals + List-Id values
-- are case-insensitive at the protocol level, so this is safe.
--
-- Defensive sequencing matters: the table has a UNIQUE primary key on
-- (match_field, match_value), so a naive `UPDATE … SET match_value =
-- LOWER(match_value)` aborts with a UNIQUE constraint error if the
-- table already contains case-variant rows for the same match_field
-- (e.g. `News@Anthropic.com` AND `news@anthropic.com` both registered
-- under `from_addr`). Because deploy-workers runs migrations BEFORE
-- deploying the worker, that abort blocks the rollout — exactly the
-- failure mode the migration is supposed to prevent.
--
-- Mitigation: deterministically delete case-variant duplicates first,
-- then run the LOWER() update on the survivors.
--
-- Idempotent: re-running on already-deduped + already-lowercased rows
-- is a no-op (DELETE has no matches, UPDATE's WHERE clause is empty).

-- Step 1: deterministic dedup. For each (match_field, LOWER(match_value))
-- group, keep the row with the lowest `created_at` and delete the rest.
-- "Oldest wins" because earliest registrations are typically the
-- operator's manually-curated mappings; later same-case-folded inserts
-- are auto-classifier output that can be re-derived from the next
-- unmatched arrival if the routing ever changes.
DELETE FROM sender_map
WHERE rowid IN (
  SELECT rowid FROM (
    SELECT
      rowid,
      ROW_NUMBER() OVER (
        PARTITION BY match_field, LOWER(match_value)
        ORDER BY created_at ASC, rowid ASC
      ) AS rn
    FROM sender_map
  )
  WHERE rn > 1
);

-- Step 2: lowercase the survivors. UNIQUE PK is now safe.
UPDATE sender_map
SET match_value = LOWER(match_value)
WHERE match_value <> LOWER(match_value);
