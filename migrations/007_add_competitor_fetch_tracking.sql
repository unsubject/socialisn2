-- 007_add_competitor_fetch_tracking.sql
--
-- Code review (2026-05-14) finding 2: the scheduler was treating
-- competitors as "due" based on last_video_at (newest video's
-- publishedAt). For a YouTube channel whose newest video is older
-- than the 4h cadence, that timestamp is permanently in the past, so
-- the scheduler enqueues a fetch on every tick (default every minute)
-- — far more often than the SPEC §7.1 cadence intends.
--
-- Add last_fetched_at + last_status so scheduling can run off the
-- ACTUAL fetch time, mirroring the sources table convention. The
-- existing last_video_at column keeps its semantic meaning (newest
-- video the worker has observed) and remains useful for ranking /
-- analytics — it just stops being the scheduling clock.

ALTER TABLE competitors
  ADD COLUMN last_fetched_at TIMESTAMPTZ,
  ADD COLUMN last_status     TEXT;
