-- Phase 2 PR 2: normalisation produces 3-7 keywords per item (SPEC §7.3).
-- Add the column to `items` so the normaliser can persist them.

ALTER TABLE items
  ADD COLUMN IF NOT EXISTS keywords TEXT[] NOT NULL DEFAULT '{}';

-- GIN index — RSS feed generation (§11.2) filters items by keyword tags.
CREATE INDEX IF NOT EXISTS idx_items_keywords ON items USING GIN (keywords);
