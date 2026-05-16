// SPEC §7.2 step 1 — hash dedup primitives.
//
// canonicaliseUrl: lower-case scheme + host, strip a leading `www.`, strip
// tracking query params (utm_*, fbclid, gclid, mc_cid, mc_eid, ref, ref_src),
// sort the remaining params alphabetically, drop fragment, strip trailing
// slash from the path. Designed to collapse "same article, different link
// decoration" without losing legitimate query state (a `?id=42` resource
// identifier is preserved).
//
// normaliseTitle: lower-case, strip Unicode punctuation, collapse runs of
// whitespace. Catches "Reuters — Foo" vs "Reuters – Foo" vs "Reuters - Foo".

import { createHash } from 'node:crypto';

const TRACKING_PARAM_PATTERNS = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^mc_cid$/i,
  /^mc_eid$/i,
  /^ref$/i,
  /^ref_src$/i,
  /^igshid$/i,
  /^_hsmi$/i,
  /^_hsenc$/i,
  // BBC News uses at_medium / at_campaign / at_link_origin etc. on every RSS link.
  /^at_/i,
];

function isTrackingParam(name: string): boolean {
  return TRACKING_PARAM_PATTERNS.some((re) => re.test(name));
}

export function canonicaliseUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    // Some feeds emit relative or otherwise malformed URLs. Fall back to the
    // raw string trimmed — the title_hash will usually catch the dup anyway.
    return input.trim();
  }
  parsed.hash = '';
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();
  // Strip a leading `www.` so example.com/x and www.example.com/x share a hash.
  // We deliberately do NOT recurse on other subdomains — m.example.com and
  // www.example.com.uk are not assumed identical.
  if (parsed.hostname.startsWith('www.') && parsed.hostname.length > 4) {
    parsed.hostname = parsed.hostname.slice(4);
  }

  // Strip tracking params and sort the rest alphabetically so query-order
  // variation (e.g. `?b=2&a=1` vs `?a=1&b=2`) doesn't change the hash.
  const sortedParams = Array.from(parsed.searchParams.entries())
    .filter(([k]) => !isTrackingParam(k))
    .sort(([a], [b]) => a.localeCompare(b));
  parsed.search = '';
  for (const [k, v] of sortedParams) {
    parsed.searchParams.append(k, v);
  }

  let pathname = parsed.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  parsed.pathname = pathname;

  return parsed.toString();
}

export function normaliseTitle(input: string): string {
  return input
    .toLowerCase()
    // \p{P} — Unicode punctuation. \p{S} — symbols (em-dash variants). Strip both.
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function urlHash(url: string): string {
  return createHash('sha256').update(canonicaliseUrl(url)).digest('hex');
}

export function titleHash(title: string): string {
  return createHash('sha256').update(normaliseTitle(title)).digest('hex');
}
