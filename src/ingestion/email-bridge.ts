// Email-bridge adapter — SPEC §6.9. Polls the Cloudflare feed-worker at
//   <EMAIL_BRIDGE_BASE>/feeds/<slug>.xml
// which serves a per-source Atom feed read out of the shared D1 inbox
// (writer side: the sibling email-worker; see ADR-003).
//
// From the ingestion-worker's perspective this is just another Atom feed,
// and the URL is already stored verbatim on the `sources` row (`kind =
// 'email_bridge'`) — the 30-min cadence is in `fetch_interval_min` per the
// SPEC §7.1 / migration 005 fix.
//
// Kept as its own file rather than inlined into the worker so that future
// per-bridge handling (boilerplate strip beyond what email-worker already
// does, link-extraction enrichment from `inbox_links`, etc.) has an
// obvious home.

import { fetchAndParseRss } from './rss.js';
import type { RawItemInput } from './types.js';

export async function fetchAndParseEmailBridge(url: string): Promise<RawItemInput[]> {
  return fetchAndParseRss(url);
}
