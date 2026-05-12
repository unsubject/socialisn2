-- 004_seed_email_bridges.sql — SPEC §6.9 Cloudflare Email Worker bridges.
--
-- Mechanism: subscribe to publisher newsletters using <slug>@socialisn.com;
-- the Worker catches all inbound mail, parses + cleans it, writes to D1, and
-- exposes per-source Atom feeds at https://inbox.socialisn.com/feeds/<slug>.xml.
-- Socialisn2's ingestion worker polls those URLs like any other RSS source.
--
-- This file covers ALL email-bridged sources: the original §6.9 newsletter-
-- only publishers plus the §6.1 / §6.2 / §6.4 outlets that lack public
-- article-level RSS. Authority and domains carried over from those sections.
--
-- fetch_interval_min per SPEC §7.1:
--   - Editorial newsletters (§6.9, §6.1, §6.2): 60 min
--   - Academic digests (§6.4 — NBER/SSRN per §7.1, others by analogy): 1440 min
--
-- IDs use gen_random_uuid() (UUIDv4) for the same reason as 002_seed_sources.sql.

INSERT INTO sources (id, kind, url, name, language, domains, authority_score, fetch_interval_min) VALUES
  -- =============================================================================
  -- §6.9 newsletter-only publishers (60 min)
  -- =============================================================================
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/anthropic.xml',  'Anthropic news',                  'en', ARRAY['scitech'], 80, 60),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/meta-ai.xml',    'Meta AI blog',                    'en', ARRAY['scitech'], 75, 60),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/hf-papers.xml',  'Hugging Face Daily Papers',       'en', ARRAY['scitech'], 75, 60),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/setser.xml',     'Brad Setser — Follow the Money',  'en', ARRAY['economy','geopolitics'], 75, 60),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/heatmap.xml',    'Heatmap News',                    'en', ARRAY['scitech'], 70, 60),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/shift-key.xml',  'Robinson Meyer — Shift Key',      'en', ARRAY['scitech'], 70, 60),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/derek-lowe.xml', 'Derek Lowe — In the Pipeline',    'en', ARRAY['scitech'], 75, 60),

  -- =============================================================================
  -- §6.1 News — General (60 min)
  -- =============================================================================
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/reuters.xml',         'Reuters',                  'en', ARRAY['geopolitics','national'], 85,                       60),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/bloomberg.xml',       'Bloomberg',                'en', ARRAY['economy','geopolitics','national'], 85,             60),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/ft.xml',              'Financial Times',          'en', ARRAY['economy','geopolitics','national'], 90,             60),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/economist.xml',      'The Economist',             'en', ARRAY['economy','geopolitics','national','economics'], 85, 60),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/wsj.xml',             'Wall Street Journal',      'en', ARRAY['economy','national'], 80,                           60),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/the-information.xml', 'The Information',          'en', ARRAY['scitech'], 85,                                      60),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/politico.xml',        'Politico (US/EU)',         'en', ARRAY['national','geopolitics'], 75,                       60),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/foreign-affairs.xml', 'Foreign Affairs',          'en', ARRAY['geopolitics'], 80,                                  60),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/foreign-policy.xml',  'Foreign Policy',           'en', ARRAY['geopolitics'], 75,                                  60),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/scmp.xml',            'South China Morning Post', 'en', ARRAY['national'], 70,                                    60),

  -- =============================================================================
  -- §6.2 Frontier Tech — Mass Market (60 min)
  -- =============================================================================
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/wired.xml',           'Wired',                  'en', ARRAY['scitech'], 70, 60),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/mit-tech-review.xml', 'MIT Technology Review',  'en', ARRAY['scitech'], 80, 60),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/ars-technica.xml',    'Ars Technica',           'en', ARRAY['scitech'], 75, 60),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/the-verge.xml',       'The Verge',              'en', ARRAY['scitech'], 65, 60),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/nature-news.xml',     'Nature News',            'en', ARRAY['scitech'], 85, 60),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/stat-news.xml',       'Stat News',              'en', ARRAY['scitech'], 80, 60),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/endpoints.xml',       'Endpoints News',         'en', ARRAY['scitech'], 80, 60),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/canary-media.xml',    'Canary Media',           'en', ARRAY['scitech'], 75, 60),

  -- =============================================================================
  -- §6.4 Academic — Economics & Adjacent (1440 min per SPEC §7.1)
  -- =============================================================================
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/nber.xml',                 'NBER Working Papers',          'en', ARRAY['economics'], 70,        1440),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/ssrn.xml',                 'SSRN top downloads',           'en', ARRAY['economics'], 65,        1440),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/voxeu.xml',                'VoxEU',                        'en', ARRAY['economics'], 65,        1440),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/aea.xml',                  'AEA papers & proceedings',     'en', ARRAY['economics'], 70,        1440),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/behavioral-scientist.xml', 'Behavioral Scientist',         'en', ARRAY['scitech','economics'], 60, 1440),
  (gen_random_uuid(), 'email_bridge', 'https://inbox.socialisn.com/feeds/asr.xml',                  'American Sociological Review', 'en', ARRAY['scitech'], 65,          1440);
