-- 002_seed_sources.sql — SPEC §6.1–§6.6 seed sources.
--
-- Excludes §6.9 (email-bridge), which lives in 004_seed_email_bridges.sql.
-- IDs use gen_random_uuid() (UUIDv4) for seed rows — deviates from SPEC §5
-- "all UUIDv7" for pre-deploy data only; app-inserted rows continue to use v7.
--
-- Only entries with RSS/Atom URLs given in SPEC are seeded here. Outlets named
-- in §6.1–§6.5 without an explicit feed URL (Reuters, Bloomberg, FT articles,
-- WSJ, Politico, Foreign Affairs, SCMP articles, Wired, MIT Tech Review,
-- Ars Technica, The Verge, Nature News, Stat News articles, Endpoints News,
-- Canary Media, NBER, SSRN, VoxEU, AEA, etc.) are intentionally NOT seeded —
-- Simon to add via MCP once their canonical RSS URLs are confirmed.

-- =============================================================================
-- §6.1 News — General (article RSS)
-- =============================================================================
INSERT INTO sources (id, kind, url, name, language, domains, authority_score) VALUES
  (gen_random_uuid(), 'rss', 'https://asia.nikkei.com/rss/feed/nar',          'Nikkei Asia',       'en', ARRAY['geopolitics','national'], 80),
  (gen_random_uuid(), 'rss', 'https://asiatimes.com/feed/',                   'Asia Times',        'en', ARRAY['geopolitics','national'], 70),
  (gen_random_uuid(), 'rss', 'https://www.project-syndicate.org/rss',         'Project Syndicate', 'en', ARRAY['economics','geopolitics'], 70);

-- =============================================================================
-- §6.1 News — Podcasts (authority inherits parent outlet)
-- =============================================================================
INSERT INTO sources (id, kind, url, name, language, domains, authority_score) VALUES
  (gen_random_uuid(), 'rss', 'https://access.acast.com/rss/39fc4a99-8861-437d-81e2-684d13e48f92',                                                                                                          'The Economist: Money Talks',                       'en', ARRAY['economy'], 85),
  (gen_random_uuid(), 'rss', 'https://access.acast.com/rss/d556eb54-6160-4c85-95f4-47d9f5216c49',                                                                                                          'The Economist: The Intelligence',                  'en', ARRAY['economy','geopolitics','national'], 85),
  (gen_random_uuid(), 'rss', 'https://access.acast.com/rss/633ebf6dfc7f5a0012acdc97',                                                                                                                      'The Economist: Drum Tower',                        'en', ARRAY['national'], 85),
  (gen_random_uuid(), 'rss', 'https://feeds.acast.com/public/shows/73fe3ede-5c5c-4850-96a8-30db8dbae8bf',                                                                                                  'Financial Times: FT News Briefing',                'en', ARRAY['economy','geopolitics','national'], 90),
  (gen_random_uuid(), 'rss', 'https://feeds.acast.com/public/shows/6a13c15d-181a-4a2e-a662-739d0e7f731a',                                                                                                  'Financial Times: The Story of Money',              'en', ARRAY['economy'], 90),
  (gen_random_uuid(), 'rss', 'https://feeds.acast.com/public/shows/6478a825654260001190a7cb',                                                                                                              'Financial Times: Unhedged',                        'en', ARRAY['economy'], 90),
  (gen_random_uuid(), 'rss', 'https://www.omnycontent.com/d/playlist/e73c998e-6e60-432f-8610-ae210140c5b1/8a94442e-5a74-4fa2-8b8d-ae27003a8d6b/982f5071-765c-403d-969d-ae27003a8d83/podcast.rss',          'Bloomberg: Odd Lots',                              'en', ARRAY['economy'], 85),
  (gen_random_uuid(), 'rss', 'https://www.omnycontent.com/d/playlist/e73c998e-6e60-432f-8610-ae210140c5b1/825d4e29-b616-46f4-afd7-ae2b0013005c/8b1dd624-a026-43e9-8b57-ae2b00130066/podcast.rss',          'Bloomberg: Big Take',                              'en', ARRAY['economy','geopolitics'], 85),
  (gen_random_uuid(), 'rss', 'https://www.omnycontent.com/d/playlist/e73c998e-6e60-432f-8610-ae210140c5b1/84f3c095-964f-4994-9d24-ae2b00130029/c9553948-bc39-4871-8989-ae2b00130032/podcast.rss',          'Bloomberg: Trumponomics',                          'en', ARRAY['economy','national'], 85),
  (gen_random_uuid(), 'rss', 'https://video-api.wsj.com/podcast/rss/wsj/the-journal',                                                                                                                      'WSJ: The Journal',                                 'en', ARRAY['economy','national'], 80),
  (gen_random_uuid(), 'rss', 'https://feeds.megaphone.fm/reutersworldnews',                                                                                                                                'Reuters: World News',                              'en', ARRAY['geopolitics','national'], 85),
  (gen_random_uuid(), 'rss', 'https://feed.podbean.com/foreignaffairsmagazine/feed.xml',                                                                                                                   'Foreign Affairs: The Foreign Affairs Interview',   'en', ARRAY['geopolitics'], 80),
  (gen_random_uuid(), 'rss', 'https://feeds.megaphone.fm/FGP8797000077',                                                                                                                                   'Foreign Policy: FP Live',                          'en', ARRAY['geopolitics'], 75),
  (gen_random_uuid(), 'rss', 'https://anchor.fm/s/9add758/podcast/rss',                                                                                                                                    'The Information: TITV',                            'en', ARRAY['scitech'], 85),
  (gen_random_uuid(), 'rss', 'https://cms.scmp.com/rss/google_assistant/325477/media_rss.xml?article-type=329431',                                                                                         'SCMP: Inside China',                               'en', ARRAY['national'], 70);

-- =============================================================================
-- §6.2 Frontier Tech — Mass Market — Podcasts
-- (Article RSS for Wired / MIT Tech Review / Ars Technica / etc. NOT in SPEC.)
-- =============================================================================
INSERT INTO sources (id, kind, url, name, language, domains, authority_score) VALUES
  (gen_random_uuid(), 'rss', 'https://feeds.megaphone.fm/inmachineswetrust',                                  'MIT Tech Review: In Machines We Trust / Narrated', 'en', ARRAY['scitech'], 80),
  (gen_random_uuid(), 'rss', 'https://publicfeeds.net/f/5901/gadget-lab',                                     'Wired: Gadget Lab / Uncanny Valley',               'en', ARRAY['scitech'], 70),
  (gen_random_uuid(), 'rss', 'https://www.statnews.com/category/first-opinion-podcast/feed/',                 'Stat News: First Opinion',                         'en', ARRAY['scitech'], 80),
  (gen_random_uuid(), 'rss', 'https://feeds.megaphone.fm/thereadoutloud',                                     'Stat News: The Readout LOUD',                      'en', ARRAY['scitech'], 80),
  (gen_random_uuid(), 'rss', 'https://feeds.acast.com/public/shows/0185cea5-9e3b-4b82-a887-26f91f92765f',     'Nature: Nature Podcast',                           'en', ARRAY['scitech'], 85);

-- =============================================================================
-- §6.3 Frontier Tech — Niche & Expert (article RSS where SPEC gives URLs)
-- =============================================================================
INSERT INTO sources (id, kind, url, name, language, domains, authority_score) VALUES
  (gen_random_uuid(), 'rss', 'https://openai.com/blog/rss.xml',          'OpenAI Blog',              'en', ARRAY['scitech'], 70),
  (gen_random_uuid(), 'rss', 'https://deepmind.google/blog/rss.xml',     'DeepMind Blog',            'en', ARRAY['scitech'], 70),
  (gen_random_uuid(), 'rss', 'https://research.google/blog/rss/',        'Google Research Blog',     'en', ARRAY['scitech'], 70),
  (gen_random_uuid(), 'rss', 'https://stratechery.com/feed/',            'Stratechery (Ben Thompson)','en', ARRAY['scitech','economics'], 75),
  (gen_random_uuid(), 'rss', 'https://semianalysis.com/feed/',           'Semianalysis',             'en', ARRAY['scitech'], 75);

-- =============================================================================
-- §6.3 arXiv (kind='arxiv', daily category listings)
-- =============================================================================
INSERT INTO sources (id, kind, url, name, language, domains, authority_score) VALUES
  (gen_random_uuid(), 'arxiv', 'http://arxiv.org/rss/cs.AI', 'arXiv cs.AI', 'en', ARRAY['scitech'], 70),
  (gen_random_uuid(), 'arxiv', 'http://arxiv.org/rss/cs.CL', 'arXiv cs.CL', 'en', ARRAY['scitech'], 70),
  (gen_random_uuid(), 'arxiv', 'http://arxiv.org/rss/cs.LG', 'arXiv cs.LG', 'en', ARRAY['scitech'], 70);

-- =============================================================================
-- §6.3 Podcasts (single feed in SPEC table)
-- =============================================================================
INSERT INTO sources (id, kind, url, name, language, domains, authority_score) VALUES
  (gen_random_uuid(), 'rss', 'http://feeds.feedburner.com/nejm-this-week-audio-summaries', 'NEJM: This Week', 'en', ARRAY['scitech'], 85);

-- =============================================================================
-- §6.5 Country-Specific Political Economy (article RSS where SPEC gives URLs)
-- =============================================================================
INSERT INTO sources (id, kind, url, name, language, domains, authority_score) VALUES
  (gen_random_uuid(), 'rss', 'https://triviumchina.com/feed/',                              'Trivium China',                 'en', ARRAY['national','geopolitics'], 65),
  (gen_random_uuid(), 'rss', 'https://gateway.caixin.com/api/data/global/feedlyRss.xml',    'Caixin Global',                 'en', ARRAY['national','economy'], 70),
  (gen_random_uuid(), 'rss', 'https://thehub.ca/feed/',                                     'The Hub (Canada)',              'en', ARRAY['national'], 60),
  (gen_random_uuid(), 'rss', 'https://www.readtheline.ca/feed',                             'The Line (Canada)',             'en', ARRAY['national'], 60),
  (gen_random_uuid(), 'rss', 'https://insidestory.org.au/feed/',                            'Inside Story (Australia)',      'en', ARRAY['national'], 60),
  (gen_random_uuid(), 'rss', 'http://feeds.feedburner.com/rsscna/engnews',                  'Focus Taiwan',                  'en', ARRAY['national'], 65),
  (gen_random_uuid(), 'rss', 'https://www.cw.com.tw/RSS/cw_content.xml',                    'CommonWealth Magazine 天下雜誌',   'zh', ARRAY['national'], 65),
  (gen_random_uuid(), 'rss', 'https://public.twreporter.org/rss/twreporter-rss.xml',        'The Reporter 報導者',              'zh', ARRAY['national'], 70);

-- =============================================================================
-- §6.5 Podcasts
-- =============================================================================
INSERT INTO sources (id, kind, url, name, language, domains, authority_score) VALUES
  (gen_random_uuid(), 'rss', 'https://feeds.megaphone.fm/radioatlantic',                                   'The Atlantic: Radio Atlantic',           'en', ARRAY['national'], 65),
  (gen_random_uuid(), 'rss', 'https://audioboom.com/channels/5114286.rss',                                 'The Bulwark Podcast',                    'en', ARRAY['national'], 60),
  (gen_random_uuid(), 'rss', 'https://feeds.megaphone.fm/DISPME9513417677',                                'The Dispatch Podcast',                   'en', ARRAY['national'], 60),
  (gen_random_uuid(), 'rss', 'https://feeds.megaphone.fm/DISPME4573820108',                                'The Dispatch: Advisory Opinions',        'en', ARRAY['national'], 60),
  (gen_random_uuid(), 'rss', 'https://feeds.acast.com/public/shows/a8a5a759-8cb1-52ad-b50a-8e08dcee4d1f',  'Tortoise / The Observer: Slow Newscast', 'en', ARRAY['national'], 65),
  (gen_random_uuid(), 'rss', 'https://feeds.acast.com/public/shows/5fad6d24bc034454b53fe011',              'UnHerd with Freddie Sayers',             'en', ARRAY['national'], 60),
  (gen_random_uuid(), 'rss', 'https://feeds.acast.com/public/shows/69cc1a3992d007a7658eee4e',              'The Hub: Hub Podcasts',                  'en', ARRAY['national'], 60);

-- =============================================================================
-- §6.6 Independent Commentators — Substack / Blog / Podcast feeds
-- =============================================================================
INSERT INTO sources (id, kind, url, name, language, domains, authority_score) VALUES
  (gen_random_uuid(), 'rss', 'https://marginalrevolution.com/feed',                                                         'Marginal Revolution (Tyler Cowen)',                  'en', ARRAY['economics','economy'], 70),
  (gen_random_uuid(), 'rss', 'https://www.noahpinion.blog/feed',                                                           'Noahpinion (Noah Smith)',                            'en', ARRAY['economy','economics'], 70),
  (gen_random_uuid(), 'rss', 'https://adamtooze.substack.com/feed',                                                        'Chartbook (Adam Tooze)',                             'en', ARRAY['economy','geopolitics'], 75),
  (gen_random_uuid(), 'rss', 'https://theovershoot.co/feed',                                                               'The Overshoot (Matthew Klein)',                      'en', ARRAY['economy'], 65),
  (gen_random_uuid(), 'rss', 'https://www.apricitas.io/feed',                                                              'Apricitas Economics (Joseph Politano)',              'en', ARRAY['economy'], 65),
  (gen_random_uuid(), 'rss', 'https://www.pragcap.com/feed/',                                                              'Pragmatic Capitalism (Cullen Roche)',                'en', ARRAY['economy'], 60),
  (gen_random_uuid(), 'rss', 'https://www.christophe-barraud.com/feed/',                                                   'Christophe Barraud',                                 'en', ARRAY['economy'], 60),
  (gen_random_uuid(), 'rss', 'https://stayathomemacro.substack.com/feed',                                                  'Stay-At-Home Macro (Claudia Sahm)',                  'en', ARRAY['economy','economics'], 70),
  (gen_random_uuid(), 'rss', 'https://glineq.blogspot.com/feeds/posts/default',                                            'globalinequality (Branko Milanovic)',                'en', ARRAY['economics'], 65),
  (gen_random_uuid(), 'rss', 'https://newsletter.platypuseconomics.com/feed',                                              'Platypus Economics (Justin Wolfers)',                'en', ARRAY['economics'], 65),
  (gen_random_uuid(), 'rss', 'https://paulkrugman.substack.com/feed',                                                      'Paul Krugman',                                       'en', ARRAY['economy','national'], 70),
  (gen_random_uuid(), 'rss', 'https://www.slowboring.com/feed',                                                            'Slow Boring (Matt Yglesias)',                        'en', ARRAY['national'], 65),
  (gen_random_uuid(), 'rss', 'https://feeds.simplecast.com/kEKXbjuJ',                                                      'The Ezra Klein Show',                                'en', ARRAY['national','geopolitics'], 70),
  (gen_random_uuid(), 'rss', 'https://www.persuasion.community/feed',                                                      'Persuasion (Yascha Mounk)',                          'en', ARRAY['geopolitics','national'], 65),
  (gen_random_uuid(), 'rss', 'https://writing.yaschamounk.com/feed',                                                       'Yascha Mounk (personal)',                            'en', ARRAY['geopolitics'], 65),
  (gen_random_uuid(), 'rss', 'https://feeds.megaphone.fm/thegoodfight',                                                    'The Good Fight (Yascha Mounk)',                      'en', ARRAY['geopolitics'], 65),
  (gen_random_uuid(), 'rss', 'https://feeds.megaphone.fm/plain-english',                                                   'Plain English (Derek Thompson)',                     'en', ARRAY['scitech','economics','national'], 70),
  (gen_random_uuid(), 'rss', 'https://bluegrassbeat.substack.com/feed',                                                    'Bluegrass Beat (Perry Bacon Jr)',                    'en', ARRAY['national'], 55),
  (gen_random_uuid(), 'rss', 'https://sinocism.com/feed',                                                                  'Sinocism (Bill Bishop)',                             'en', ARRAY['national','geopolitics'], 80),
  (gen_random_uuid(), 'rss', 'https://www.chinatalk.media/feed',                                                           'ChinaTalk Newsletter (Jordan Schneider)',            'en', ARRAY['national','scitech'], 75),
  (gen_random_uuid(), 'rss', 'https://feeds.megaphone.fm/CHTAL4990341033',                                                 'ChinaTalk Podcast (Jordan Schneider)',               'en', ARRAY['national','scitech'], 75),
  (gen_random_uuid(), 'rss', 'https://ian-johnson.com/feed/',                                                              'Ian Johnson',                                        'en', ARRAY['national'], 60),
  (gen_random_uuid(), 'rss', 'https://www.worksinprogress.news/feed',                                                      'Works in Progress (Sam Bowman et al.)',              'en', ARRAY['scitech','economics'], 70),
  (gen_random_uuid(), 'rss', 'https://www.theglobeandmail.com/arc/outboundfeeds/rss/author/acoyne/?outputType=xml',        'Andrew Coyne (Globe and Mail)',                      'en', ARRAY['national'], 65),
  (gen_random_uuid(), 'rss', 'https://worthwhileblog.ca/feed/',                                                            'Worthwhile Canadian Initiative (Stephen Gordon)',    'en', ARRAY['national','economics'], 60),
  (gen_random_uuid(), 'rss', 'https://johnquiggin.com/feed/',                                                              'John Quiggin',                                       'en', ARRAY['national','economics'], 60),
  (gen_random_uuid(), 'rss', 'https://sauleslake.substack.com/feed',                                                       'Saul Eslake',                                        'en', ARRAY['national','economy'], 60),
  (gen_random_uuid(), 'rss', 'https://karpathy.github.io/feed.xml',                                                        'Andrej Karpathy (Jekyll blog)',                      'en', ARRAY['scitech'], 75),
  (gen_random_uuid(), 'rss', 'https://karpathy.bearblog.dev/feed/',                                                        'Andrej Karpathy (bearblog)',                         'en', ARRAY['scitech'], 75),
  (gen_random_uuid(), 'rss', 'https://simonwillison.net/atom/everything/',                                                 'Simon Willison',                                     'en', ARRAY['scitech'], 75),
  (gen_random_uuid(), 'rss', 'https://www.dwarkesh.com/feed',                                                              'Dwarkesh Patel',                                     'en', ARRAY['scitech'], 70),
  (gen_random_uuid(), 'rss', 'https://blog.eleuther.ai/index.xml',                                                         'EleutherAI Blog',                                    'en', ARRAY['scitech'], 70),
  (gen_random_uuid(), 'rss', 'https://importai.substack.com/feed',                                                         'Import AI (Jack Clark)',                             'en', ARRAY['scitech'], 75),
  (gen_random_uuid(), 'rss', 'https://www.volts.wtf/feed',                                                                 'Volts (David Roberts)',                              'en', ARRAY['scitech','national'], 70),
  (gen_random_uuid(), 'rss', 'https://newsletter.doomberg.com/feed',                                                       'Doomberg',                                           'en', ARRAY['scitech','economy'], 65),
  (gen_random_uuid(), 'rss', 'https://erictopol.substack.com/feed',                                                        'Ground Truths (Eric Topol)',                         'en', ARRAY['scitech'], 75);
