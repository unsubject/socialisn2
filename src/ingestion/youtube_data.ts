// YouTube Data API v3 client for backfill (SPEC §13).
//
// Used for Simon's OWN channel only — fetching the last N months of
// videos with title + description + publishedAt, so Phase 5 PR 1's
// labeling step can compute "this historical cluster looks like
// something Simon already published, so it's a positive label."
//
// Distinct from src/ingestion/youtube.ts, which uses the public
// per-channel Atom feed for COMPETITOR channels (no auth, last-15-
// videos cap per ADR-004). The Atom feed isn't enough for backfill
// — we need the full 12-month history with stable pagination, and
// that requires the paid Data API.
//
// Quota: 10K units/day free. resolveChannelId = 1 unit; each
// playlistItems page = 1 unit returning up to 50 items (cost is
// per call, independent of how many parts are requested). A typical
// 12-month pull for Simon's channel (~52 videos) is 2-3 calls total.
// Well inside the free quota even with backfill re-runs.

import { env } from '../config/env.js';

const API_BASE = 'https://youtube.googleapis.com/youtube/v3';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 50;

export interface YouTubeVideo {
  videoId: string;
  url: string;
  title: string;
  description: string;
  publishedAt: Date;
  channelId: string;
}

export interface YouTubeDataOptions {
  /** Override fetch — primarily for tests. */
  fetchFn?: typeof fetch;
  /** External abort signal — wins over the per-call timeout. */
  signal?: AbortSignal;
  /** Per-call timeout (ms). Default 30s. */
  timeoutMs?: number;
}

/**
 * The uploads playlist for any YouTube channel is deterministically
 * derived from the channel id by replacing the leading `UC` with
 * `UU`. No API call needed — saves a quota unit.
 *
 * Throws on channel ids that don't start with `UC` (legacy / custom
 * url shapes the Data API surfaces under different fields).
 */
export function uploadsPlaylistIdFromChannelId(channelId: string): string {
  if (!channelId.startsWith('UC')) {
    throw new Error(
      `uploadsPlaylistIdFromChannelId: channel id must start with "UC" (got ${channelId})`,
    );
  }
  return `UU${channelId.slice(2)}`;
}

/**
 * Resolve `@handle` to a `UC...` channel id via the channels endpoint.
 * Caller can also pass a bare handle without the leading `@` — we add
 * it. Returns the channel id; throws if the handle doesn't resolve.
 *
 * Quota: 1 unit.
 */
export async function resolveChannelId(
  handle: string,
  opts: YouTubeDataOptions = {},
): Promise<string> {
  const apiKey = env.youtubeApiKey();
  if (!apiKey) {
    throw new Error(
      'resolveChannelId: YOUTUBE_API_KEY not set — backfill YouTube-Data path is disabled',
    );
  }
  const normalised = handle.startsWith('@') ? handle : `@${handle}`;
  const url = `${API_BASE}/channels?part=id&forHandle=${encodeURIComponent(normalised)}&key=${encodeURIComponent(apiKey)}`;
  const json = await getJson<ChannelsResponse>(url, opts);
  const item = json.items?.[0];
  if (!item?.id) {
    throw new Error(
      `resolveChannelId: no channel for handle ${normalised} (response: ${JSON.stringify(json).slice(0, 200)})`,
    );
  }
  return item.id;
}

export interface FetchPlaylistOptions extends YouTubeDataOptions {
  /** Skip videos with `videoPublishedAt < since`. Filter only — NOT
   *  an early-stop signal. Playlist order is by playlist-add time
   *  (`snippet.publishedAt`), which can diverge from
   *  `contentDetails.videoPublishedAt` for scheduled / private→public
   *  uploads, so a later page can still contain in-window items.
   *  Pagination always continues to the end of the playlist;
   *  bound it with `maxItems` if a channel might have thousands of
   *  videos. Default: no filter. */
  since?: Date;
  /** Items per page. Default 50 (the API max). */
  pageSize?: number;
  /** Hard cap on items returned across all pages. Default unlimited
   *  (subject to quota). Useful as a safety net for misconfigured
   *  channels with thousands of videos. */
  maxItems?: number;
}

/**
 * Fetch all videos in a playlist (typically the channel's uploads
 * playlist), paginating until the playlist is exhausted or
 * `maxItems` is hit.
 *
 * Date semantics: `YouTubeVideo.publishedAt` is the video's public
 * publish time (`contentDetails.videoPublishedAt`), not the time it
 * was added to the playlist (`snippet.publishedAt`). For uploads
 * playlists they usually match, but scheduled / private→public
 * uploads diverge and we want the reader-visible date for cutoff
 * + storage. Falls back to `snippet.publishedAt` when
 * `contentDetails` is absent (e.g. videos that have never been
 * public, partial responses).
 *
 * `since` is a filter only, not an early-stop signal: see the
 * `since` field doc on `FetchPlaylistOptions` for why.
 *
 * Quota: 1 unit per page (up to 50 items).
 */
export async function fetchPlaylistVideos(
  playlistId: string,
  opts: FetchPlaylistOptions = {},
): Promise<YouTubeVideo[]> {
  const apiKey = env.youtubeApiKey();
  if (!apiKey) {
    throw new Error(
      'fetchPlaylistVideos: YOUTUBE_API_KEY not set — backfill YouTube-Data path is disabled',
    );
  }
  const pageSize = Math.min(opts.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const since = opts.since;
  const out: YouTubeVideo[] = [];
  let pageToken: string | undefined;

  while (true) {
    const params = new URLSearchParams({
      part: 'snippet,contentDetails',
      playlistId,
      maxResults: String(pageSize),
      key: apiKey,
    });
    if (pageToken) params.set('pageToken', pageToken);
    const json = await getJson<PlaylistItemsResponse>(
      `${API_BASE}/playlistItems?${params.toString()}`,
      opts,
    );

    for (const item of json.items ?? []) {
      const snippet = item.snippet;
      if (!snippet) continue;
      const videoId = snippet.resourceId?.videoId;
      const channelId = snippet.videoOwnerChannelId ?? snippet.channelId;
      if (!videoId || !channelId) continue;
      // Prefer the actual publish time; fall back to playlist-add time
      // when the API omits contentDetails (e.g. never-public videos).
      const publishedAtRaw =
        item.contentDetails?.videoPublishedAt ?? snippet.publishedAt;
      const publishedAt = new Date(publishedAtRaw);
      if (Number.isNaN(publishedAt.getTime())) continue;
      // Filter only. We can't early-stop on this check: a later page
      // can hold a video whose playlist-add time is older but whose
      // public publish time is inside `since` (scheduled→public).
      if (since && publishedAt < since) continue;
      out.push({
        videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title: snippet.title ?? '',
        description: snippet.description ?? '',
        publishedAt,
        channelId,
      });
      if (opts.maxItems !== undefined && out.length >= opts.maxItems) return out;
    }

    if (!json.nextPageToken) return out;
    pageToken = json.nextPageToken;
  }
}

/**
 * Composite: resolve a `@handle` to its channel, derive the uploads
 * playlist id, and fetch every video newest-first, keeping those
 * whose `videoPublishedAt >= since`.
 *
 * Quota: 1 (channels) + ceil(N/50) (playlistItems pages) units,
 * where N is the playlist size (NOT the `since`-filtered count —
 * see `FetchPlaylistOptions.since`).
 */
export async function fetchChannelVideosSince(
  handle: string,
  since: Date,
  opts: YouTubeDataOptions = {},
): Promise<YouTubeVideo[]> {
  const channelId = await resolveChannelId(handle, opts);
  const playlistId = uploadsPlaylistIdFromChannelId(channelId);
  return fetchPlaylistVideos(playlistId, { ...opts, since });
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

interface ChannelsResponse {
  items?: Array<{ id: string }>;
}

interface PlaylistItemsResponse {
  items?: Array<{
    snippet?: {
      title?: string;
      description?: string;
      publishedAt: string;
      channelId?: string;
      videoOwnerChannelId?: string;
      resourceId?: { videoId?: string };
    };
    contentDetails?: {
      videoPublishedAt?: string;
    };
  }>;
  nextPageToken?: string;
}

async function getJson<T>(url: string, opts: YouTubeDataOptions): Promise<T> {
  const doFetch = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': env.httpUserAgent(),
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '<no body>')).slice(0, 300);
    throw new Error(
      `youtube-data: HTTP ${res.status} from ${maskKey(url)}: ${detail}`,
    );
  }
  return (await res.json()) as T;
}

/** Replace the API key in a URL with `***` for safe logging. */
function maskKey(url: string): string {
  return url.replace(/key=[^&]+/, 'key=***');
}
