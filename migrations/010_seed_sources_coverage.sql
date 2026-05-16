-- 010_seed_sources_coverage.sql — fills SPEC §6.3 / §6.5 seed gaps flagged
-- in the Phase 0-2 audit (2026-05-16).
--
-- Adds outlets the original 002 left as TODOs with the rationale "await a
-- per-outlet RSS-availability check". This migration only includes URLs
-- the audit-time verifier could confirm with reasonable confidence; the
-- remaining outlets (paywalled or no obvious public RSS) get follow-up
-- Build tasks rather than dead seed rows.
--
-- IDs use gen_random_uuid() — same convention as 002 for pre-deploy data.
-- Authority and cadence per SPEC §7.1: news/substack 60 min, preprint
-- servers 1440 min (mirror arXiv).

-- =============================================================================
-- §6.3 Frontier Tech — Niche & Expert / IT-CS (60 min cadence)
-- =============================================================================
-- Hacker News: SPEC also asks for a domain whitelist post-filter. The v1
-- mitigation is hnrss.org's server-side `points=100` floor — drops the
-- firehose to ~10-20 stories/day. The post-fetch domain whitelist is
-- tracked as a follow-up Build task; until it lands, HN signal will be
-- broader than the §6.3 intent.
INSERT INTO sources (id, kind, url, name, language, domains, authority_score, fetch_interval_min) VALUES
  (gen_random_uuid(), 'rss', 'https://hnrss.org/best?points=100', 'Hacker News (best, points>=100)', 'en', ARRAY['scitech'], 60, 60);

-- =============================================================================
-- §6.3 Energy (60 min cadence)
-- IEA + BloombergNEF deferred — no public RSS confirmed at seed time.
-- NBER energy/environment is already carried via the §6.4 email bridge.
-- =============================================================================
INSERT INTO sources (id, kind, url, name, language, domains, authority_score, fetch_interval_min) VALUES
  (gen_random_uuid(), 'rss', 'https://rmi.org/feed/', 'RMI (Rocky Mountain Institute)', 'en', ARRAY['scitech','economy'], 65, 60);

-- =============================================================================
-- §6.3 Biological / Pharmaceutical (kind='rss', preprint servers at 1440 min
-- to mirror arXiv's daily-listing cadence per SPEC §7.1).
-- NEJM open abstracts deferred — open-content RSS not confirmed.
-- =============================================================================
INSERT INTO sources (id, kind, url, name, language, domains, authority_score, fetch_interval_min) VALUES
  (gen_random_uuid(), 'rss', 'https://connect.biorxiv.org/biorxiv_xml.php?subject=neuroscience',       'bioRxiv: Neuroscience',       'en', ARRAY['scitech'], 65, 1440),
  (gen_random_uuid(), 'rss', 'https://connect.biorxiv.org/biorxiv_xml.php?subject=synthetic_biology', 'bioRxiv: Synthetic Biology',  'en', ARRAY['scitech'], 65, 1440),
  (gen_random_uuid(), 'rss', 'https://connect.biorxiv.org/biorxiv_xml.php?subject=cancer_biology',    'bioRxiv: Cancer Biology',     'en', ARRAY['scitech'], 65, 1440),
  (gen_random_uuid(), 'rss', 'https://connect.biorxiv.org/biorxiv_xml.php?subject=immunology',        'bioRxiv: Immunology',         'en', ARRAY['scitech'], 65, 1440),
  (gen_random_uuid(), 'rss', 'https://connect.biorxiv.org/biorxiv_xml.php?subject=genomics',          'bioRxiv: Genomics',           'en', ARRAY['scitech'], 65, 1440),
  (gen_random_uuid(), 'rss', 'https://connect.medrxiv.org/medrxiv_xml.php?subject=epidemiology',      'medRxiv: Epidemiology',       'en', ARRAY['scitech'], 65, 1440),
  (gen_random_uuid(), 'rss', 'https://connect.medrxiv.org/medrxiv_xml.php?subject=oncology',          'medRxiv: Oncology',           'en', ARRAY['scitech'], 65, 1440),
  (gen_random_uuid(), 'rss', 'https://www.nature.com/nm.rss',                                         'Nature Medicine',             'en', ARRAY['scitech'], 85, 60),
  (gen_random_uuid(), 'rss', 'https://www.thetransmitter.org/feed/',                                  'The Transmitter (neuroscience)','en', ARRAY['scitech'], 65, 60);

-- =============================================================================
-- §6.5 USA — article RSS (60 min cadence)
-- The Bulwark and The Dispatch article RSS deferred — uncertain feed URLs;
-- their podcasts are already in 002.
-- =============================================================================
INSERT INTO sources (id, kind, url, name, language, domains, authority_score, fetch_interval_min) VALUES
  (gen_random_uuid(), 'rss', 'https://rss.politico.com/politics-news.xml', 'Politico',           'en', ARRAY['national'], 70, 60),
  (gen_random_uuid(), 'rss', 'https://api.axios.com/feed/',                 'Axios',              'en', ARRAY['national'], 70, 60),
  (gen_random_uuid(), 'rss', 'https://www.theatlantic.com/feed/all/',       'The Atlantic',       'en', ARRAY['national'], 75, 60),
  (gen_random_uuid(), 'rss', 'https://reason.com/feed/',                    'Reason',             'en', ARRAY['national'], 60, 60);

-- =============================================================================
-- §6.5 UK — article RSS (60 min cadence)
-- The Times (UK) deferred — heavy paywall, RSS access uncertain.
-- =============================================================================
INSERT INTO sources (id, kind, url, name, language, domains, authority_score, fetch_interval_min) VALUES
  (gen_random_uuid(), 'rss', 'https://www.theguardian.com/politics/rss', 'The Guardian: Politics',   'en', ARRAY['national'], 75, 60),
  (gen_random_uuid(), 'rss', 'https://www.theguardian.com/business/rss', 'The Guardian: Business',   'en', ARRAY['economy'],  75, 60),
  (gen_random_uuid(), 'rss', 'https://unherd.com/feed/',                  'UnHerd',                   'en', ARRAY['national'], 60, 60),
  (gen_random_uuid(), 'rss', 'https://www.conservativehome.com/feed',     'ConservativeHome',         'en', ARRAY['national'], 55, 60),
  (gen_random_uuid(), 'rss', 'https://labourlist.org/feed/',              'LabourList',               'en', ARRAY['national'], 55, 60);

-- =============================================================================
-- §6.5 Canada — article RSS (60 min cadence)
-- Globe and Mail politics/business deferred — section-RSS URL pattern
-- inconsistent across categories at seed time; the existing Andrew Coyne
-- author feed (in 002) still covers G&M voice.
-- =============================================================================
INSERT INTO sources (id, kind, url, name, language, domains, authority_score, fetch_interval_min) VALUES
  (gen_random_uuid(), 'rss', 'https://nationalpost.com/feed/', 'National Post', 'en', ARRAY['national'], 65, 60),
  (gen_random_uuid(), 'rss', 'https://macleans.ca/feed/',      'Maclean''s',    'en', ARRAY['national'], 60, 60);

-- =============================================================================
-- §6.5 Australia — article RSS (60 min cadence)
-- The Australian, ABC News politics, and Crikey deferred — paywall or
-- uncertain section-RSS URLs; Inside Story is already in 002.
-- =============================================================================
INSERT INTO sources (id, kind, url, name, language, domains, authority_score, fetch_interval_min) VALUES
  (gen_random_uuid(), 'rss', 'https://theconversation.com/au/articles.atom', 'The Conversation AU', 'en', ARRAY['national'], 60, 60);

-- =============================================================================
-- §6.5 Taiwan — article RSS (60 min cadence)
-- =============================================================================
INSERT INTO sources (id, kind, url, name, language, domains, authority_score, fetch_interval_min) VALUES
  (gen_random_uuid(), 'rss', 'https://www.taipeitimes.com/xml/index.rss', 'Taipei Times', 'en', ARRAY['national'], 65, 60);
