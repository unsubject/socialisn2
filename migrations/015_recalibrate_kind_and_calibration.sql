-- 015_recalibrate_kind_and_calibration.sql
--
-- Obs-3: source-authority recalibration (ADR-013).
--
-- Two changes:
--   1. Widen runs.kind CHECK to accept 'recalibrate' (the new daily cron's
--      run-row kind, distinct from 'morning'/'afternoon'/'manual').
--   2. Add `authority_score_seed` + `authority_score_calibrated_at` to the
--      sources table. The seed column anchors the Beta-Bernoulli prior so
--      the cron can recompute the posterior without losing the original
--      hand-curated authority from migrations 002 + 010.
--
-- The runs CHECK constraint in 001_init.sql is declared inline on the
-- column, which PostgreSQL auto-names `<table>_<column>_check` →
-- `runs_kind_check`. That name is stable across PG versions for inline
-- column CHECKs; if a future PG release ever changes the convention this
-- migration will fail loudly at DROP CONSTRAINT and we'll re-issue it
-- with the discovered name.

-- 1. Widen runs.kind ----------------------------------------------------------
ALTER TABLE runs DROP CONSTRAINT runs_kind_check;
ALTER TABLE runs ADD CONSTRAINT runs_kind_check
  CHECK (kind IN ('morning', 'afternoon', 'manual', 'recalibrate'));

-- 2. Add per-source calibration columns ---------------------------------------
ALTER TABLE sources
  ADD COLUMN authority_score_seed INT,
  ADD COLUMN authority_score_calibrated_at TIMESTAMPTZ;

-- Seed `authority_score_seed` from the current `authority_score` for every
-- existing row — the value migration 002 / 010 / 003-via-add_influencer
-- wrote IS the seed by definition (no recalibration has run yet).
--
-- Going forward, any new INSERT path (src/mcp/tools/sources.ts:add_influencer)
-- sets authority_score_seed explicitly; the DEFAULT 50 below matches
-- authority_score's default so legacy INSERT sites that omit both
-- columns continue to land sensible rows.
UPDATE sources SET authority_score_seed = authority_score
  WHERE authority_score_seed IS NULL;

ALTER TABLE sources
  ALTER COLUMN authority_score_seed SET DEFAULT 50,
  ALTER COLUMN authority_score_seed SET NOT NULL;
