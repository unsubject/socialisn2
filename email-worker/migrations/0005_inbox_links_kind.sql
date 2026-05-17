-- 0005_inbox_links_kind.sql — classify each extracted link at ingest
-- so feed-worker (and future consumers) can prefer the article URL
-- over the masthead / "view in browser" / social-share URL that
-- typically appears first in newsletter HTML.
--
-- Kinds (TEXT, free-form but the email-worker only writes these five):
--   'article'   — content link; the one the Atom feed should expose
--   'masthead'  — view-in-browser, publisher logo / homepage link
--   'social'    — share-on-Twitter/Facebook/LinkedIn/etc.
--   'tracking'  — beacon / pixel / open-tracking pseudo-URLs
--   'other'     — fallback, including the default for rows written
--                 before this migration
--
-- This migration is NOT idempotent on its own — SQLite has no
-- `ALTER TABLE … ADD COLUMN IF NOT EXISTS`. It relies on wrangler's
-- migration tracker (`d1_migrations`) skipping already-applied files,
-- which is the existing pattern for this project.

ALTER TABLE inbox_links ADD COLUMN link_kind TEXT NOT NULL DEFAULT 'other';

-- Composite covering index for the feed-worker's "prefer article, fall
-- back to any" subqueries. (slug, message_id) is the existing PK prefix;
-- adding link_kind + link_pos lets both subqueries be served from the
-- index without touching the base table.
CREATE INDEX IF NOT EXISTS idx_inbox_links_message_kind
  ON inbox_links (slug, message_id, link_kind, link_pos);
