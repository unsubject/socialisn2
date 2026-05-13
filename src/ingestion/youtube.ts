// YouTube competitor-channel adapter — SPEC §6.7.
//
// Uses YouTube's native per-channel RSS Atom feed at
//   https://www.youtube.com/feeds/videos.xml?channel_id=<id>
// which satisfies the no-scraping policy (ADR-003). The feed always returns
// the latest 15 videos.
//
// Per ADR-004, v1 does NOT call the YouTube Data API for chapter timestamps
// or duration. The RSS gives us videoId / title / description / publishedAt
// which is the full v1 signal; `duration_sec` is left null until Whisper
// runs against a promoted video (Phase 2 PR 1, ADR-006).
//
// The atom item shape rss-parser surfaces by default doesn't include the
// `<yt:videoId>` / `<yt:channelId>` / `<media:group>` namespaces. The first
// two are added via customFields. For the third (which carries the actual
// video description in `<media:description>`), rss-parser keeps the nested
// XML as a parsed object — we pull the description defensively.

import Parser from 'rss-parser';

import { env } from '../config/env.js';

type YouTubeFeedItem = Parser.Item & {
  videoId?: string;
  channelId?: string;
  mediaGroup?: {
    'media:description'?: string | string[];
    'media:title'?: string | string[];
  };
};

type YouTubeFeedShape = Parser.Output<YouTubeFeedItem> & {
  // The channel-level <yt:channelId> can also be useful for sanity checks
  // (does the feed match the competitor row we asked about?) but we don't
  // act on it in v1.
  channelId?: string;
};

export interface CompetitorVideoInput {
  externalId: string; // the YouTube videoId
  url: string;
  title: string;
  description: string | null;
  publishedAt: Date;
}

export function buildChannelFeedUrl(channelId: string): string {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
}

function makeYouTubeParser(): Parser<YouTubeFeedShape, YouTubeFeedItem> {
  return new Parser<YouTubeFeedShape, YouTubeFeedItem>({
    timeout: env.httpTimeoutMs(),
    headers: {
      'User-Agent': env.httpUserAgent(),
      Accept: 'application/atom+xml, application/xml;q=0.9, */*;q=0.8',
    },
    customFields: {
      item: [
        ['yt:videoId', 'videoId'],
        ['yt:channelId', 'channelId'],
        ['media:group', 'mediaGroup'],
      ],
    },
  });
}

function pickDescription(item: YouTubeFeedItem): string | null {
  const fromMedia = item.mediaGroup?.['media:description'];
  if (typeof fromMedia === 'string' && fromMedia.length > 0) return fromMedia;
  if (Array.isArray(fromMedia) && typeof fromMedia[0] === 'string' && fromMedia[0].length > 0) {
    return fromMedia[0];
  }
  // Fallback to rss-parser's own surface, on the off-chance a future feed
  // variant exposes <content> at the entry level.
  return item.content ?? item.contentSnippet ?? null;
}

function pickPublishedAt(item: YouTubeFeedItem): Date {
  const candidates = [item.isoDate, item.pubDate];
  for (const c of candidates) {
    if (!c) continue;
    const parsed = new Date(c);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

export async function parseYouTubeXml(xml: string): Promise<CompetitorVideoInput[]> {
  const parser = makeYouTubeParser();
  const feed = await parser.parseString(xml);
  return feedToVideos(feed);
}

export async function fetchAndParseYouTube(channelId: string): Promise<CompetitorVideoInput[]> {
  const parser = makeYouTubeParser();
  const feed = await parser.parseURL(buildChannelFeedUrl(channelId));
  return feedToVideos(feed);
}

function feedToVideos(feed: YouTubeFeedShape): CompetitorVideoInput[] {
  const out: CompetitorVideoInput[] = [];
  for (const item of feed.items ?? []) {
    if (!item.videoId) continue;
    if (!item.link) continue;
    const title = (item.title ?? '').trim();
    if (!title) continue;

    out.push({
      externalId: item.videoId,
      url: item.link,
      title,
      description: pickDescription(item),
      publishedAt: pickPublishedAt(item),
    });
  }
  return out;
}
