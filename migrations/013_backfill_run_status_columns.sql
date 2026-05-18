-- Phase 5 PR 1 — backfill_run provenance columns per ADR-012.
--
-- ADR-012 supersedes ADR-011: backfill skips ALL historical signal sources
-- (RSS + GDELT-as-discovery). The job records what corpora WERE loaded
-- (YouTube channel last-12mo via Data API, 2nd-brain corpus availability
-- via archive_search probe) instead of computing historical clusters.
--
-- All columns NULLable so a future ADR can re-enable historical-discovery
-- paths without a schema migration.

ALTER TABLE backfill_run
  ADD COLUMN IF NOT EXISTS rss_history_status   TEXT,
  ADD COLUMN IF NOT EXISTS gdelt_history_status TEXT,
  ADD COLUMN IF NOT EXISTS youtube_corpus_size  INTEGER,
  ADD COLUMN IF NOT EXISTS brain_corpus_status  TEXT;

-- v1: both history sources are skipped by definition; the column values
-- are constants from ADR-012. CHECK constraints reserve room for future
-- non-'skipped' values (e.g. 'wayback', 'newsapi', 'gdelt_topic_seeds')
-- without committing to a name now.
ALTER TABLE backfill_run
  ADD CONSTRAINT backfill_run_rss_history_status_check
    CHECK (rss_history_status IS NULL OR rss_history_status IN ('skipped', 'wayback', 'newsapi')),
  ADD CONSTRAINT backfill_run_gdelt_history_status_check
    CHECK (gdelt_history_status IS NULL OR gdelt_history_status IN ('skipped', 'topic_seeds', 'bigquery')),
  ADD CONSTRAINT backfill_run_brain_corpus_status_check
    CHECK (brain_corpus_status IS NULL OR brain_corpus_status IN ('available', 'unreachable', 'not_configured'));
