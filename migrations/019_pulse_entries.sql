-- 019: pulse entries (feed redesign P0.3,
-- docs/redesign/2026-07-05-ideation-redesign.md §5.1).
--
-- The Daily Pulse is an append-only, attention-budgeted feed: each
-- scoring run contributes at most PULSE_TOP_N candidate entries (plus
-- one morning waves entry). Entries are snapshots — a row is written
-- once at run time and never mutated, so pulse.xml items keep stable
-- GUIDs and never re-order under a reader's feet the way the live
-- candidate pool does.

CREATE TABLE pulse_entries (
  id           UUID PRIMARY KEY,
  run_id       UUID NOT NULL REFERENCES runs(id),
  kind         TEXT NOT NULL,
  candidate_id UUID REFERENCES candidates(id),
  rank         INTEGER,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (kind IN ('candidate', 'waves')),
  CHECK (kind <> 'candidate' OR candidate_id IS NOT NULL)
);

CREATE INDEX idx_pulse_entries_created_at ON pulse_entries(created_at DESC);
