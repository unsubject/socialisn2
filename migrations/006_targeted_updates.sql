-- 006_targeted_updates.sql — three corrections grouped into one migration.
--
-- 1. Shift Key — moves from §6.9 email-bridge to §6.6 podcast feed. An open
--    Acast feed exists (https://feeds.acast.com/public/shows/shift-key), so
--    the bridge path is no longer warranted.
-- 2. §6.6 substack/blog/atom cadence: 60 → 90 min. Stays within the SPEC §7.1
--    "60–120 min" range; reduces traffic without materially affecting
--    detection. Podcast and substack+podcast rows in §6.6 stay at 120.
-- 3. §6.4 academic email-bridge authority bumps. SPEC §6.4 doesn't pin numbers
--    explicitly; PR #6 seeded with 65–70 defaults. Peer-reviewed top-tier
--    (NBER, AEA, ASR) move into the FT/Reuters tier; VoxEU bumps modestly.

-- ---------------------------------------------------------------------------
-- 1. Shift Key: email_bridge → §6.6 podcast feed
-- ---------------------------------------------------------------------------
DELETE FROM sources
WHERE kind = 'email_bridge' AND name = 'Robinson Meyer — Shift Key';

INSERT INTO sources (id, kind, url, name, language, domains, authority_score, fetch_interval_min)
VALUES (
  gen_random_uuid(),
  'rss',
  'https://feeds.acast.com/public/shows/shift-key',
  'Shift Key (Robinson Meyer & Jesse Jenkins)',
  'en',
  ARRAY['scitech'],
  70,
  120
);

-- ---------------------------------------------------------------------------
-- 2. §6.6 substack/blog/atom cadence 60 → 90
-- (Explicit URL list excludes §6.6 podcast / substack+podcast rows at 120 and
--  every other section's RSS rows. 30 URLs total.)
-- ---------------------------------------------------------------------------
UPDATE sources SET fetch_interval_min = 90
WHERE fetch_interval_min = 60
  AND url IN (
    'https://marginalrevolution.com/feed',
    'https://www.noahpinion.blog/feed',
    'https://adamtooze.substack.com/feed',
    'https://theovershoot.co/feed',
    'https://www.apricitas.io/feed',
    'https://www.pragcap.com/feed/',
    'https://www.christophe-barraud.com/feed/',
    'https://stayathomemacro.substack.com/feed',
    'https://glineq.blogspot.com/feeds/posts/default',
    'https://newsletter.platypuseconomics.com/feed',
    'https://paulkrugman.substack.com/feed',
    'https://www.slowboring.com/feed',
    'https://www.persuasion.community/feed',
    'https://writing.yaschamounk.com/feed',
    'https://bluegrassbeat.substack.com/feed',
    'https://sinocism.com/feed',
    'https://www.chinatalk.media/feed',
    'https://ian-johnson.com/feed/',
    'https://www.worksinprogress.news/feed',
    'https://www.theglobeandmail.com/arc/outboundfeeds/rss/author/acoyne/?outputType=xml',
    'https://worthwhileblog.ca/feed/',
    'https://johnquiggin.com/feed/',
    'https://sauleslake.substack.com/feed',
    'https://karpathy.github.io/feed.xml',
    'https://karpathy.bearblog.dev/feed/',
    'https://simonwillison.net/atom/everything/',
    'https://blog.eleuther.ai/index.xml',
    'https://importai.substack.com/feed',
    'https://newsletter.doomberg.com/feed',
    'https://erictopol.substack.com/feed'
  );

-- ---------------------------------------------------------------------------
-- 3. §6.4 academic authority bumps (peer-reviewed top-tier into 80–85)
-- ---------------------------------------------------------------------------
UPDATE sources SET authority_score = 80 WHERE name = 'NBER Working Papers';
UPDATE sources SET authority_score = 85 WHERE name = 'AEA papers & proceedings';
UPDATE sources SET authority_score = 80 WHERE name = 'American Sociological Review';
UPDATE sources SET authority_score = 70 WHERE name = 'VoxEU';
-- SSRN (65) and Behavioral Scientist (60) unchanged.
