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
--
-- UPDATE in place so the source `id` is preserved and any existing
-- `raw_items.source_id` references stay valid. A DELETE+INSERT would have
-- failed the FK constraint on any DB that had already fetched at least one
-- Shift Key item via the bridge. authority_score and domains are unchanged
-- (both already 70 / ARRAY['scitech']) so they don't need to be in the SET.
-- ---------------------------------------------------------------------------
UPDATE sources
SET kind = 'rss',
    url = 'https://feeds.acast.com/public/shows/shift-key',
    name = 'Shift Key (Robinson Meyer & Jesse Jenkins)',
    fetch_interval_min = 120,
    updated_at = NOW()
WHERE kind = 'email_bridge' AND name = 'Robinson Meyer — Shift Key';

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
