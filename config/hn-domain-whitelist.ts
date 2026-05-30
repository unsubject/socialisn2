// HN ingestion post-filter — list of editorial-trusted publication hosts.
//
// SPEC §6.3 mandates a domain whitelist post-filter for the Hacker News
// feed (`hnrss.org/best?points=100` per migrations/010). The v1
// server-side `points=100` floor drops the firehose to ~10–20 stories
// per day, but the remaining items still include personal blogs, GitHub
// project pages, mailing-list archives, and self-promo on Substack —
// none of which carry editorial signal at the level socialisn2 curates
// for. This list defines which hosts ARE editorial signal.
//
// What's on the list:
//   - Major news / business / general (NYT, FT, Bloomberg, Guardian, …)
//   - Tech publications + analysis (Ars Technica, The Verge, Wired,
//     Stratechery, …)
//   - Academic + research (Nature, Science, NEJM, arXiv, …)
//   - High-signal newsletters / substacks where the author IS the editorial
//     filter (Stratechery, Slow Boring, AstralCodexTen, …)
//
// What's NOT on the list:
//   - GitHub / GitLab / Bitbucket project pages (tools, not editorial)
//   - Personal blogs without a track record (any host not below)
//   - Mailing list archives (lkml.org etc.)
//   - Random Medium / Substack (specific authors only — added by name)
//
// Match semantics: case-insensitive, `www.` stripped, ANY subdomain of a
// listed apex domain matches (so `dealbook.nytimes.com` and
// `cooking.nytimes.com` both pass when `nytimes.com` is listed). This is
// permissive on purpose — editorial signal can come from sub-properties
// of the parent publication.
//
// Maintenance: this list lives in code on purpose — adding / removing a
// host is a reviewed PR, not a runtime config change. Each entry should
// have at most one editorial domain tag (economy / scitech / geopolitics /
// national) so a future per-domain refinement can fan out from here.

/**
 * Editorial-trusted apex domains. Lowercase, no protocol, no `www.`.
 * Matched against the URL host's apex (longest registrable suffix-aware).
 * See `extractApex` in src/ingestion/hn-filter.ts.
 */
export const HN_DOMAIN_WHITELIST = new Set<string>([
  // --- General / national news --------------------------------------------
  'nytimes.com',
  'washingtonpost.com',
  'wsj.com',
  'ft.com',
  'theguardian.com',
  'bbc.com',
  'bbc.co.uk',
  'reuters.com',
  'apnews.com',
  'bloomberg.com',
  'economist.com',
  'theatlantic.com',
  'newyorker.com',
  'newrepublic.com',
  'politico.com',
  'axios.com',
  'thehill.com',
  'time.com',
  'vox.com',
  'fivethirtyeight.com',
  'theinformation.com',
  'semafor.com',

  // --- Tech publications --------------------------------------------------
  'arstechnica.com',
  'theverge.com',
  'wired.com',
  'technologyreview.com', // MIT Tech Review
  'spectrum.ieee.org',
  'ieee.org',
  'acm.org',
  'lwn.net',
  'phoronix.com',
  'thenewstack.io',
  'theregister.com',
  'protocol.com',
  'restofworld.org',

  // --- Substack / newsletter editorial voices -----------------------------
  // Apex `substack.com` would match every Substack — too permissive. Each
  // editorial voice is listed by their custom domain OR
  // `<author>.substack.com` (matched literally because substack.com is NOT
  // an apex match — only direct entries hit).
  'stratechery.com',
  'astralcodexten.com',
  'slowboring.com',
  'noahpinion.blog',
  'matthewyglesias.substack.com',
  'mattlevine.bloomberg.com', // Bloomberg Opinion via apex but listed for clarity
  'oneusefulthing.org', // Ethan Mollick
  'pluralistic.net', // Cory Doctorow
  'danluu.com',
  'jasonkottke.org',
  'kotaku.com', // games but routinely surfaces tech-industry signal
  'lesswrong.com',

  // --- Academic + research ------------------------------------------------
  'nature.com',
  'science.org',
  'pnas.org',
  'nejm.org',
  'cell.com',
  'thelancet.com',
  'arxiv.org',
  'biorxiv.org',
  'medrxiv.org',
  'nih.gov',
  'cdc.gov',
  'who.int',

  // --- Geopolitics + national-security ------------------------------------
  'foreignaffairs.com',
  'foreignpolicy.com',
  'cfr.org', // Council on Foreign Relations
  'rand.org',
  'csis.org',
  'brookings.edu',
  'aei.org',
  'piie.com', // Peterson Institute
  'sipri.org',
  'iiss.org',

  // --- Asia / HK-adjacent (per socialisn2 editorial weighting) ------------
  'scmp.com',
  'nikkei.com',
  'asia.nikkei.com',
  'reuters.com', // dup-safe (Set)
  'caixin.com',
  'sixthtone.com',
]);

/**
 * URL-matchers for HN source URLs. A source whose URL matches any of
 * these patterns is treated as Hacker News and is subject to the
 * whitelist filter. Anything else passes through untouched.
 */
export const HN_SOURCE_URL_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)hnrss\.org\//i,
  /news\.ycombinator\.com/i,
];
