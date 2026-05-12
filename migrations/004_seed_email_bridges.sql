-- 004_seed_email_bridges.sql — SPEC §6.9 Cloudflare Email Worker bridges.
--
-- Mechanism: subscribe to publisher newsletters using <slug>@socialisn.com;
-- the Worker catches all inbound mail, parses + cleans it, writes to D1, and
-- exposes per-source Atom feeds at https://inbox.socialisn.com/feeds/<slug>.xml.
-- Socialisn2's ingestion worker polls those URLs like any other RSS source.
--
-- IDs use gen_random_uuid() (UUIDv4) for the same reason as 002_seed_sources.sql.

INSERT INTO sources (id, kind, url, name, language, domains, authority_score) VALUES
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/anthropic.xml',  'Anthropic news',                  'en', ARRAY['scitech'], 80),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/meta-ai.xml',    'Meta AI blog',                    'en', ARRAY['scitech'], 75),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/hf-papers.xml',  'Hugging Face Daily Papers',       'en', ARRAY['scitech'], 75),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/setser.xml',     'Brad Setser — Follow the Money',  'en', ARRAY['economy','geopolitics'], 75),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/heatmap.xml',    'Heatmap News',                    'en', ARRAY['scitech'], 70),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/shift-key.xml',  'Robinson Meyer — Shift Key',      'en', ARRAY['scitech'], 70),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/derek-lowe.xml', 'Derek Lowe — In the Pipeline',    'en', ARRAY['scitech'], 75);
