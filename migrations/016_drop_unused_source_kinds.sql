-- 016_drop_unused_source_kinds.sql
--
-- Closes audit item (5) from the 2026-05-16 Phase 0-2 deferred list:
-- sources.kind CHECK still allowed 'youtube_channel' and 'gdelt' from
-- migration 001 (reserved-for-future), but no code path has ever
-- inserted rows with either kind. Verified 2026-05-30:
--   - migrations 002 / 003 / 004 / 010 only seed 'rss' / 'arxiv' /
--     'email_bridge'
--   - src/mcp/tools/sources.ts:add_influencer hardcodes 'rss'
--   - src/ingestion/gdelt.ts writes to gdelt_coverage (its own table);
--     src/ingestion/youtube.ts writes to competitor_videos. Neither
--     INSERTs into sources.
--
-- The CHECK in 001_init.sql is declared as an unnamed TABLE-level
-- constraint (separated from the column definition), so PostgreSQL
-- auto-names it — the exact spelling varies across PG point-releases.
-- Look it up by matching the constraint definition rather than guessing.

-- ---------------------------------------------------------------------------
-- 1. Pre-flight: refuse to run if any row actually uses the dropped kinds.
--    A failed migration is far better than silent loss of operator-inserted
--    data — operators would see a clear error and can either migrate the
--    rows to a still-allowed kind or delete them.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    bad_count INT;
BEGIN
    SELECT COUNT(*)::INT INTO bad_count FROM sources
    WHERE kind IN ('youtube_channel', 'gdelt');
    IF bad_count > 0 THEN
        RAISE EXCEPTION 'Migration 016 refuses to run: % rows in sources have kind in (youtube_channel, gdelt). Migrate or delete those rows first.', bad_count;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Drop the existing kind-CHECK by predicate-match lookup, then add a
--    named replacement so future migrations can DROP CONSTRAINT by name.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    SELECT con.conname INTO constraint_name
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid
    WHERE cl.relname = 'sources'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) LIKE '%youtube_channel%';
    IF constraint_name IS NULL THEN
        -- Already dropped (idempotent re-run). The matching ADD CONSTRAINT
        -- below would then fail with "already exists" — short-circuit
        -- both halves of the rewrite by exiting now.
        RAISE NOTICE 'Migration 016: no kind-CHECK mentioning youtube_channel found; assuming already migrated.';
        RETURN;
    END IF;
    EXECUTE format('ALTER TABLE sources DROP CONSTRAINT %I', constraint_name);
    ALTER TABLE sources ADD CONSTRAINT sources_kind_check
        CHECK (kind IN ('rss', 'arxiv', 'email_bridge'));
END $$;
