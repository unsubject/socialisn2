-- 0001_inbox.sql — D1 schema for SPEC §6.9 (single-inbox + List-Id pattern).
-- Cloudflare D1 is SQLite-backed.
--
-- Tables:
--   inbox        — matched inbound emails, one row per email
--   inbox_links  — JOIN table for links extracted from each email body
--   sender_map   — (match_field, match_value) → slug lookup (List-Id → from_addr → from_domain)
--   unmatched    — emails with no sender_map match; operator triage queue
--
-- Idempotent: every statement uses IF NOT EXISTS so re-running the
-- bootstrap-d1 workflow on an already-initialised database is a no-op
-- (does not error). Schema changes go in a NEW migration file
-- (0002_*.sql, etc.) — never amend an applied migration in place.

CREATE TABLE IF NOT EXISTS inbox (
  slug         TEXT NOT NULL,
  message_id   TEXT NOT NULL,
  received_at  INTEGER NOT NULL,        -- unix milliseconds, set by the worker
  subject      TEXT,
  body_text    TEXT,
  body_html    TEXT,
  PRIMARY KEY (slug, message_id)
);
CREATE INDEX IF NOT EXISTS idx_inbox_slug_received_at ON inbox (slug, received_at DESC);

CREATE TABLE IF NOT EXISTS inbox_links (
  slug         TEXT NOT NULL,
  message_id   TEXT NOT NULL,
  link_pos     INTEGER NOT NULL,        -- ordinal of the link within the email body
  link_url     TEXT NOT NULL,
  PRIMARY KEY (slug, message_id, link_pos),
  FOREIGN KEY (slug, message_id) REFERENCES inbox(slug, message_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_inbox_links_url ON inbox_links (link_url);

CREATE TABLE IF NOT EXISTS sender_map (
  match_field  TEXT NOT NULL,           -- 'list_id' | 'from_addr' | 'from_domain'
  match_value  TEXT NOT NULL,           -- the literal header value to match
  slug         TEXT NOT NULL,           -- the source slug to route to
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (match_field, match_value)
);
CREATE INDEX IF NOT EXISTS idx_sender_map_slug ON sender_map (slug);

CREATE TABLE IF NOT EXISTS unmatched (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at  INTEGER NOT NULL,
  list_id      TEXT,
  from_addr    TEXT,
  subject      TEXT
);
CREATE INDEX IF NOT EXISTS idx_unmatched_received_at ON unmatched (received_at DESC);
