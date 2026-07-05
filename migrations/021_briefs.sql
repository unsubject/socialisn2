-- 021: weekly ideation briefs (redesign P1,
-- docs/redesign/2026-07-05-ideation-redesign.md §5.2).
--
-- One row per weekly brief. `week_of` is the date the brief was
-- generated for (the Sunday of the run); UNIQUE so a manual re-run
-- regenerates that week's brief in place (upsert) instead of stacking
-- duplicates in the feed. `pitches` holds the structured episode
-- pitches; `content_md` is the rendered markdown used by MCP/Telegram
-- consumers (the HTML page + feed render from `pitches` directly).

CREATE TABLE briefs (
  id          UUID PRIMARY KEY,
  week_of     DATE NOT NULL UNIQUE,
  pitches     JSONB NOT NULL,
  content_md  TEXT NOT NULL,
  model       TEXT NOT NULL,
  cost_usd    NUMERIC(10,6) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ
);

CREATE INDEX idx_briefs_created_at ON briefs(created_at DESC);

-- The brief job records itself in `runs` (observability via /status +
-- cost_ledger.run_id FK) — admit the new kind. NOTE: preserve
-- 'recalibrate', added by migration 015.
ALTER TABLE runs DROP CONSTRAINT runs_kind_check;
ALTER TABLE runs ADD CONSTRAINT runs_kind_check
  CHECK (kind IN ('morning', 'afternoon', 'manual', 'recalibrate', 'brief'));
