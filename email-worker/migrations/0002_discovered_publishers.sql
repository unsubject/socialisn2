-- 0002_discovered_publishers.sql — LLM-classified publisher metadata.
--
-- Companion to sender_map. When the classifier (scripts/
-- auto-classify-bridges.ts) sees a new (list_id, from_addr, from_domain)
-- combo in `unmatched`, it asks an LLM with web-search to identify the
-- publisher and write a row here describing it (name, primary_domain,
-- authority score, language, reasoning). The sender_map row links the
-- raw header value to the slug for the email-worker's hot path; this
-- table is the descriptive metadata, useful for ops + for the future
-- D1→Postgres sync that populates `sources` rows.
--
-- v1: D1-only. Phase 1 PR 4 + later add a VPS-side cron that reads
-- this table and upserts into Postgres `sources` (kind='email_bridge').

CREATE TABLE IF NOT EXISTS discovered_publishers (
  slug           TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  primary_domain TEXT NOT NULL,            -- 'scitech' | 'economy' | 'geopolitics' | 'national' | 'economics'
  domains        TEXT NOT NULL,            -- JSON array of domain strings
  authority      INTEGER NOT NULL,         -- 0-100; see prompt for reference scale
  language       TEXT NOT NULL,            -- ISO 639-1
  reasoning      TEXT,                     -- LLM's brief justification, for audit
  discovered_at  INTEGER NOT NULL          -- unix milliseconds
);
CREATE INDEX IF NOT EXISTS idx_discovered_publishers_domain
  ON discovered_publishers (primary_domain);
