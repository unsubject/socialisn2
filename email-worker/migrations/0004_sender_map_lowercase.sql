-- One-time normalisation: lowercase every existing sender_map.match_value
-- so the case-folded lookup in email-worker/src/sender-map.ts hits the
-- same value writers now store (also lowercased). Email locals + List-Id
-- values are case-insensitive at the protocol level, so this is safe.
--
-- Idempotent: running it again over already-lowercased rows is a no-op
-- (UPDATE … WHERE row_changes_only happens at the SQL layer).

UPDATE sender_map
SET match_value = LOWER(match_value)
WHERE match_value <> LOWER(match_value);
