// Pure parsing helpers for email-handler.ts. Kept independent of the
// Workers runtime so they can be unit-tested under plain Node + vitest
// without spinning up Miniflare.

const BOILERPLATE_MARKERS: RegExp[] = [
  // Common newsletter footer phrasing. Case-insensitive, multi-line
  // anchored: we cut from the FIRST appearance of any marker onward.
  // Aggressive by design — preserving the unsubscribe / list-management
  // block has no clustering value and pollutes the downstream embedding.
  /^[ \t]*unsubscribe\b/im,
  /^[ \t]*if you no longer wish to receive/im,
  /^[ \t]*view (this )?(email|message) in your browser/im,
  /^[ \t]*this (email|message) was sent to /im,
  /^[ \t]*to stop receiving/im,
  /^[ \t]*manage (your )?(subscription|preferences)/im,
  /^[ \t]*update your preferences/im,
  /^[ \t]*sent (with )?love by/im,
  /^[ \t]*©\s*\d{4}/im,
  /^[ \t]*copyright\s*©/im,
];

/**
 * Cut the body at the FIRST boilerplate marker we recognise. Returns the
 * prefix as a trimmed string. If no marker fires, returns the input
 * trimmed. Empty input → empty string.
 *
 * First-line guard: a marker that appears with fewer than
 * MIN_LEAD_NONEMPTY_LINES content lines before it is treated as preamble
 * (e.g. an issue's "View this email in your browser" header) rather than
 * the footer it was designed to detect. Without this, a newsletter whose
 * first line IS the marker had its entire body cut to empty. PR #33
 * review surfaced this; tracked in the 2026-05-16 Phase 0-2 audit
 * deferred list. Threshold=1 fixes the absolute-first-line case without
 * changing behavior for any other shape we have a test for.
 *
 * When a marker appears BOTH as preamble (skipped) AND later as a real
 * footer, the later occurrence is honored — see `findFirstHonoredMatch`
 * walking matchAll, not stopping at the first match.
 */
const MIN_LEAD_NONEMPTY_LINES = 1;

function nonEmptyLinesBefore(text: string, idx: number): number {
  let count = 0;
  let pos = 0;
  while (pos < idx) {
    let nl = text.indexOf('\n', pos);
    if (nl === -1 || nl > idx) nl = idx;
    const line = text.slice(pos, nl);
    if (line.trim().length > 0) count += 1;
    if (nl === idx) break;
    pos = nl + 1;
  }
  return count;
}

function findFirstHonoredMatch(re: RegExp, text: string): number | null {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const globalRe = new RegExp(re.source, flags);
  let m: RegExpExecArray | null;
  while ((m = globalRe.exec(text)) !== null) {
    if (nonEmptyLinesBefore(text, m.index) >= MIN_LEAD_NONEMPTY_LINES) {
      return m.index;
    }
    // Zero-length match would infinite-loop on lastIndex; the markers
    // here always consume at least one char ("u" in "unsubscribe"
    // etc.) so this is defensive only.
    if (m.index === globalRe.lastIndex) globalRe.lastIndex += 1;
  }
  return null;
}

export function stripBoilerplate(text: string): string {
  if (!text) return '';
  let cutAt = text.length;
  for (const re of BOILERPLATE_MARKERS) {
    const idx = findFirstHonoredMatch(re, text);
    if (idx !== null && idx < cutAt) cutAt = idx;
  }
  return text.slice(0, cutAt).trimEnd();
}

// Link classification persisted in inbox_links.link_kind. The feed-worker
// prefers 'article' so cross-source url_hash dedup matches the canonical
// article URL rather than the masthead / view-in-browser link. Kinds are
// derived from URL shape alone — extractLinks only sees the href, not the
// surrounding anchor text or DOM position class.
export type LinkKind = 'article' | 'masthead' | 'social' | 'tracking' | 'other';

export interface ExtractedLink {
  url: string;
  pos: number;
  kind: LinkKind;
}

const HREF_RE = /<a\s[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
const BARE_URL_RE = /\bhttps?:\/\/[^\s<>"')]+/g;

// Hosts whose presence in the URL means "share on X" / "talk on Y" rather
// than the article itself. Newsletters routinely include a row of share
// links above or below each story; downstream clustering would prefer the
// underlying article.
const SOCIAL_HOSTS = new Set<string>([
  'twitter.com',
  'x.com',
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'reddit.com',
  'pinterest.com',
  'threads.net',
  't.me',
  'tiktok.com',
  'mastodon.social',
  'bsky.app',
  'youtube.com',
  'youtu.be',
]);

// Path / query fragments that mark a link as the issue's HTML mirror or
// the publisher's homepage masthead rather than an article body link.
// Matched on lowercased pathname + search.
const MASTHEAD_PATTERNS: RegExp[] = [
  /\bview[-_/.]?(this[-_/.]?)?(email|message)?[-_/.]?(in|on)?[-_/.]?(your[-_/.]?)?(browser|web|online)\b/,
  /\bread[-_/.]?(in|on)?[-_/.]?(browser|web|online)\b/,
  /\bview[-_/.]?in[-_/.]?browser\b/,
  /\bweb[-_/.]?version\b/,
];

const TRACKING_PATTERNS: RegExp[] = [
  /\b(beacon|pixel|open\.gif|open\.png|tracking\.gif|track\/open)\b/,
];

// Query params known to carry tracking metadata only — not content
// intent. Used by the homepage-masthead check to recognise URLs like
// `https://publisher.com/?utm_source=newsletter` as masthead even
// though `parsed.search` is non-empty. Conservative set: each entry
// here is unambiguously a tracking-only param across the public web.
// We don't strip these from the stored link_url — classification just
// reads through them.
const TRACKING_QUERY_PARAMS = new Set<string>([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_name',
  'utm_brand',
  'fbclid',
  'gclid',
  'msclkid',
  'dclid',
  'yclid',
  'mc_cid', // Mailchimp campaign id
  'mc_eid', // Mailchimp encrypted recipient id
  '_hsmi', // HubSpot
  '_hsenc', // HubSpot
  'mkt_tok', // Marketo
]);

function hasOnlyTrackingParams(searchParams: URLSearchParams): boolean {
  for (const key of searchParams.keys()) {
    if (!TRACKING_QUERY_PARAMS.has(key.toLowerCase())) return false;
  }
  // Empty params satisfy vacuously — the no-query case is also "homepage".
  return true;
}

function classifyLink(rawUrl: string): LinkKind {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // Unparseable URL (e.g. relative href that slipped past the
    // protocol check). Tag as 'other' rather than guessing; the feed
    // handler's fallback path will still consider it.
    return 'other';
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (SOCIAL_HOSTS.has(host)) return 'social';

  const pathAndSearch = `${parsed.pathname}${parsed.search}`.toLowerCase();
  for (const re of TRACKING_PATTERNS) {
    if (re.test(pathAndSearch)) return 'tracking';
  }
  for (const re of MASTHEAD_PATTERNS) {
    if (re.test(pathAndSearch)) return 'masthead';
  }

  // Homepage-style link (host root with no meaningful query) — the
  // publisher logo pointing at their root URL is the classic masthead
  // pattern. Newsletters routinely tack utm_*/mc_*/etc. tracking params
  // onto the masthead URL; treat search as empty when only such params
  // are present so the masthead doesn't get mis-classified as article.
  if (
    (parsed.pathname === '' || parsed.pathname === '/') &&
    hasOnlyTrackingParams(parsed.searchParams)
  ) {
    return 'masthead';
  }

  return 'article';
}

/**
 * Pull links out of an email body. Prefers HTML when available (parses
 * <a href>); falls back to bare-URL regex on plain text. Returns links in
 * document order with a 0-based positional index and a kind classification
 * (article|masthead|social|tracking|other) used by feed-worker to pick the
 * canonical article URL.
 *
 * Filters out anchors, mailto:, javascript:, tel:, and obvious unsubscribe
 * URLs entirely — those carry no editorial signal and would pollute the
 * inbox_links join.
 */
export function extractLinks(opts: {
  html?: string | null;
  text?: string | null;
}): ExtractedLink[] {
  const out: ExtractedLink[] = [];
  const seen = new Set<string>();
  const push = (rawUrl: string): void => {
    const url = rawUrl.trim();
    if (!url) return;
    if (url.startsWith('#')) return;
    if (url.startsWith('mailto:')) return;
    if (url.startsWith('javascript:')) return;
    if (url.startsWith('tel:')) return;
    // Drop the common one-click unsubscribe / preferences URLs — operators
    // care about content links, not list-management endpoints.
    if (/\b(unsubscribe|email[-_ ]?preferences|opt[-_ ]?out)\b/i.test(url)) {
      return;
    }
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ url, pos: out.length, kind: classifyLink(url) });
  };

  if (opts.html && opts.html.length > 0) {
    let m: RegExpExecArray | null;
    HREF_RE.lastIndex = 0;
    while ((m = HREF_RE.exec(opts.html)) !== null) {
      if (m[1]) push(m[1]);
    }
    return out;
  }

  if (opts.text && opts.text.length > 0) {
    let m: RegExpExecArray | null;
    BARE_URL_RE.lastIndex = 0;
    while ((m = BARE_URL_RE.exec(opts.text)) !== null) {
      push(m[0]);
    }
  }
  return out;
}
