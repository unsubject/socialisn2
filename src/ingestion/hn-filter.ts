// HN ingestion post-filter — SPEC §6.3 / migration 010 follow-up.
//
// hnrss.org's `?points=100` server-side filter drops the firehose to
// ~10–20 stories/day, but a meaningful share of those still link to
// non-editorial hosts (GitHub project pages, personal blogs without an
// editorial track record, mailing-list archives). This module is the
// post-fetch domain whitelist that keeps only items whose target URL
// host is on `config/hn-domain-whitelist.ts`.
//
// Applies ONLY to sources whose feed URL matches one of the HN URL
// patterns. Every other source passes through unchanged — non-HN
// sources are operator-curated and shouldn't need a post-filter.
//
// Why not earlier in the pipeline:
//   - rss.ts is the generic RSS adapter; injecting HN-specific logic
//     there couples the adapter to source-type knowledge it shouldn't
//     need
//   - writer.ts is concerned with dedup + persistence; filtering
//     editorial items belongs upstream
//   - This module lives between fetch and write in
//     src/workers/ingestion.ts: a thin pure-function wrapper

import {
  HN_DOMAIN_WHITELIST,
  HN_SOURCE_URL_PATTERNS,
} from '../../config/hn-domain-whitelist.js';
import type { RawItemInput } from './types.js';

/**
 * Does this source URL look like Hacker News (and therefore need
 * post-filtering)? Conservative — only true for known HN feed shapes.
 */
export function isHnSourceUrl(sourceUrl: string): boolean {
  for (const re of HN_SOURCE_URL_PATTERNS) {
    if (re.test(sourceUrl)) return true;
  }
  return false;
}

/**
 * Lowercase host minus a single optional `www.` prefix. Returns null
 * for unparseable URLs — caller drops the item rather than guess.
 */
function extractHost(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return parsed.hostname.toLowerCase().replace(/^www\./, '');
}

/**
 * Return true iff `host` is the listed apex OR a subdomain of it.
 * Matching is right-anchored and case-folded by the caller.
 *
 * Example: `apex = 'nytimes.com'` matches `nytimes.com` and
 * `dealbook.nytimes.com` but NOT `nytimes.com.evil.example`.
 */
function hostMatchesApex(host: string, apex: string): boolean {
  if (host === apex) return true;
  return host.endsWith(`.${apex}`);
}

function hostIsWhitelisted(host: string): boolean {
  // Direct match against any listed apex. Stored as Set for O(N) iteration
  // (N ≈ 50 — Set membership check via the equality path; the
  // apex-vs-subdomain match requires iteration regardless).
  for (const apex of HN_DOMAIN_WHITELIST) {
    if (hostMatchesApex(host, apex)) return true;
  }
  return false;
}

/**
 * Pure filter. Drops items whose target URL host is not on the
 * editorial whitelist. Returns the (possibly shorter) array AND a
 * count of dropped items so the worker can log the filter rate.
 */
export function applyDomainWhitelist(items: RawItemInput[]): {
  kept: RawItemInput[];
  droppedCount: number;
} {
  const kept: RawItemInput[] = [];
  let droppedCount = 0;
  for (const item of items) {
    const host = extractHost(item.url);
    if (host === null) {
      droppedCount += 1;
      continue;
    }
    if (!hostIsWhitelisted(host)) {
      droppedCount += 1;
      continue;
    }
    kept.push(item);
  }
  return { kept, droppedCount };
}

/**
 * Entry point used by the ingestion worker. No-op for non-HN sources.
 * `sourceUrl` is the source row's `url` column — the FEED url, not the
 * per-item story URL.
 */
export function filterHnIngestion(
  sourceUrl: string,
  items: RawItemInput[],
): { kept: RawItemInput[]; droppedCount: number } {
  if (!isHnSourceUrl(sourceUrl)) {
    return { kept: items, droppedCount: 0 };
  }
  return applyDomainWhitelist(items);
}
