// RSS / Atom adapter — the single ingestion path for §6.1 news, §6.2 mass-
// market tech, §6.4 academic, §6.5 country-specific, §6.6 commentators, and
// every podcast subsection across §6.1–§6.6.
//
// v1 captures the feed-supplied content only (title + summary / description /
// show notes). No HTML scraping of linked pages — that violates the no-scraping
// policy in SPEC §2 / ADR-003. Audio transcription for podcasts lands later
// (Phase 2 PR 1, ADR-006).
//
// The parser is exposed as `parseRssXml` for unit-testing against fixture XML;
// `fetchAndParseRss` is the thin network wrapper used by the worker.

import Parser from 'rss-parser';

import { env } from '../config/env.js';
import type { RawItemInput } from './types.js';

// rss-parser maps common RSS 2.0 and Atom fields into a unified Item shape,
// but a few Atom-only fields land outside its default TS surface. Declared
// here so the adapter can read them without `any`.
//   <dc:creator>                       → item.creator
//   <content:encoded>, Atom <content>  → item.content
//   <description>                      → item.contentSnippet
//   <guid>                             → item.guid
//   Atom <id>                          → item.id
//   Atom <author><name>                → item.author
//   <pubDate>, Atom <updated/published>→ item.isoDate (preferred) + item.pubDate

type FeedItem = Parser.Item & {
  id?: string;
  author?: string;
};
type FeedShape = Parser.Output<FeedItem>;

function makeParser(): Parser<FeedShape, FeedItem> {
  return new Parser<FeedShape, FeedItem>({
    timeout: env.httpTimeoutMs(),
    headers: {
      'User-Agent': env.httpUserAgent(),
      Accept: 'application/atom+xml, application/rss+xml, application/xml;q=0.9, */*;q=0.8',
    },
  });
}

function pickPublishedAt(item: FeedItem): Date {
  const candidates = [item.isoDate, item.pubDate];
  for (const c of candidates) {
    if (!c) continue;
    const parsed = new Date(c);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  // Fallback to now: better than dropping an item; the downstream normaliser
  // can correct from inline date strings if needed.
  return new Date();
}

function pickContent(item: FeedItem): string | null {
  return item.content ?? item.contentSnippet ?? null;
}

function pickAuthor(item: FeedItem): string | null {
  return item.creator ?? item.author ?? null;
}

function pickExternalId(item: FeedItem): string | null {
  if (typeof item.guid === 'string' && item.guid.length > 0) return item.guid;
  if (typeof item.id === 'string' && item.id.length > 0) return item.id;
  return null;
}

/**
 * Parse a raw RSS / Atom XML string into normalised items.
 * Pure function — no network, no DB. Suitable for unit tests.
 */
export async function parseRssXml(xml: string): Promise<RawItemInput[]> {
  const parser = makeParser();
  const feed = await parser.parseString(xml);
  return feedToRawItems(feed);
}

/**
 * Fetch the URL and parse it.
 */
export async function fetchAndParseRss(url: string): Promise<RawItemInput[]> {
  const parser = makeParser();
  const feed = await parser.parseURL(url);
  return feedToRawItems(feed);
}

function feedToRawItems(feed: FeedShape): RawItemInput[] {
  const out: RawItemInput[] = [];
  for (const item of feed.items ?? []) {
    if (!item.link) continue;
    const title = (item.title ?? '').trim();
    if (!title) continue;

    const externalId = pickExternalId(item) ?? item.link;
    out.push({
      externalId,
      url: item.link,
      title,
      content: pickContent(item),
      author: pickAuthor(item),
      publishedAt: pickPublishedAt(item),
      // Per-item language is rarely set by feeds; the feed-level language is
      // not surfaced by rss-parser's default types. Phase 2 normalisation
      // detects language from content directly.
      language: null,
      rawMeta: {
        feedTitle: feed.title ?? null,
        categories: item.categories ?? null,
        enclosure: item.enclosure ?? null,
      },
    });
  }
  return out;
}
