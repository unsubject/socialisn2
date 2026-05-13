// arXiv daily-listing adapter — SPEC §6.3 (cs.AI / cs.CL / cs.LG + future
// bioRxiv / medRxiv). arXiv exposes per-category RSS at
//   http://arxiv.org/rss/<category>
// The format is RDF / RSS 1.0, which rss-parser handles. So the per-item
// shape after parsing is identical to RSS 2.0 — title, link, description,
// pubDate. Authors land in `creator` (often comma-separated for multi-author
// papers; v1 stores the raw string and lets Phase 2 normalisation extract
// the list).
//
// Daily cadence (1440 min) is enforced by the source row, not by this file.
//
// Future bioRxiv / medRxiv URLs (e.g. https://www.biorxiv.org/biorxiv_xml.php
// ?subject=...) will go through this adapter unchanged once seeded — the
// underlying RSS parsing is the same.

import { fetchAndParseRss } from './rss.js';
import type { RawItemInput } from './types.js';

export async function fetchAndParseArxiv(url: string): Promise<RawItemInput[]> {
  return fetchAndParseRss(url);
}
