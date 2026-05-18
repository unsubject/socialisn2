// Unit tests for src/ingestion/youtube_data.ts.
// Stubbed fetch — no real YouTube API calls.

import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  fetchChannelVideosSince,
  fetchPlaylistVideos,
  resolveChannelId,
  uploadsPlaylistIdFromChannelId,
} from '../../src/ingestion/youtube_data.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.YOUTUBE_API_KEY = 'AIzaSyTEST-test-test-test-test-test-test';
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('uploadsPlaylistIdFromChannelId', () => {
  it('maps UCxxx → UUxxx', () => {
    expect(uploadsPlaylistIdFromChannelId('UCabcdefghijklmnopqrstuv')).toBe(
      'UUabcdefghijklmnopqrstuv',
    );
  });

  it('throws on non-UC channel id', () => {
    expect(() => uploadsPlaylistIdFromChannelId('foo')).toThrow(/must start with "UC"/);
  });
});

describe('resolveChannelId', () => {
  it('returns the channel id from forHandle lookup', async () => {
    let captured: string | undefined;
    const fakeFetch: typeof fetch = async (url) => {
      captured = String(url);
      return jsonResponse({ items: [{ id: 'UCabc123' }] });
    };
    const id = await resolveChannelId('@leesimon', { fetchFn: fakeFetch });
    expect(id).toBe('UCabc123');
    expect(captured).toContain('forHandle=%40leesimon');
    expect(captured).toContain('key=AIzaSyTEST');
  });

  it('adds the leading @ when caller omits it', async () => {
    let captured: string | undefined;
    const fakeFetch: typeof fetch = async (url) => {
      captured = String(url);
      return jsonResponse({ items: [{ id: 'UCxyz' }] });
    };
    await resolveChannelId('leesimon', { fetchFn: fakeFetch });
    expect(captured).toContain('forHandle=%40leesimon');
  });

  it('throws when YOUTUBE_API_KEY is empty', async () => {
    process.env.YOUTUBE_API_KEY = '';
    await expect(resolveChannelId('@x')).rejects.toThrow(/YOUTUBE_API_KEY not set/);
  });

  it('throws when the handle resolves to zero items', async () => {
    const fakeFetch: typeof fetch = async () => jsonResponse({ items: [] });
    await expect(
      resolveChannelId('@bogus', { fetchFn: fakeFetch }),
    ).rejects.toThrow(/no channel for handle/);
  });
});

describe('fetchPlaylistVideos', () => {
  it('requests part=snippet,contentDetails', async () => {
    let captured: string | undefined;
    const fakeFetch: typeof fetch = async (url) => {
      captured = String(url);
      return jsonResponse({
        items: [mkItem('v1', 'first', '2026-05-10T00:00:00Z')],
      });
    };
    await fetchPlaylistVideos('UUabc', { fetchFn: fakeFetch });
    // URLSearchParams percent-encodes the comma → snippet%2CcontentDetails.
    expect(captured).toMatch(/part=snippet%2CcontentDetails/);
  });

  it('returns all items in one page when no nextPageToken', async () => {
    const fakeFetch: typeof fetch = async () =>
      jsonResponse({
        items: [
          mkItem('v1', 'first', '2026-05-10T00:00:00Z'),
          mkItem('v2', 'second', '2026-05-09T00:00:00Z'),
        ],
      });
    const videos = await fetchPlaylistVideos('UUabc', { fetchFn: fakeFetch });
    expect(videos).toHaveLength(2);
    expect(videos[0]?.videoId).toBe('v1');
    expect(videos[0]?.url).toBe('https://www.youtube.com/watch?v=v1');
    expect(videos[0]?.title).toBe('first');
    expect(videos[0]?.publishedAt.toISOString()).toBe('2026-05-10T00:00:00.000Z');
  });

  it('paginates via nextPageToken until empty', async () => {
    let call = 0;
    const fakeFetch: typeof fetch = async (url) => {
      call += 1;
      const u = String(url);
      if (!u.includes('pageToken=')) {
        return jsonResponse({
          items: [mkItem('v1', 'a', '2026-05-10T00:00:00Z')],
          nextPageToken: 'PG2',
        });
      }
      if (u.includes('pageToken=PG2')) {
        return jsonResponse({
          items: [mkItem('v2', 'b', '2026-05-09T00:00:00Z')],
          nextPageToken: 'PG3',
        });
      }
      // PG3 — last page, no nextPageToken
      return jsonResponse({
        items: [mkItem('v3', 'c', '2026-05-08T00:00:00Z')],
      });
    };
    const videos = await fetchPlaylistVideos('UUabc', { fetchFn: fakeFetch });
    expect(call).toBe(3);
    expect(videos.map((v) => v.videoId)).toEqual(['v1', 'v2', 'v3']);
  });

  it('prefers contentDetails.videoPublishedAt over snippet.publishedAt', async () => {
    // Real divergence: item added to the uploads playlist in March
    // (scheduled/private), then made public in May. Readers see the May
    // date; backfill must record the May date.
    const fakeFetch: typeof fetch = async () =>
      jsonResponse({
        items: [
          {
            snippet: {
              title: 'scheduled',
              description: 'd',
              publishedAt: '2026-03-01T00:00:00Z',
              videoOwnerChannelId: 'UCowner',
              resourceId: { videoId: 'v1' },
            },
            contentDetails: { videoPublishedAt: '2026-05-10T00:00:00Z' },
          },
        ],
      });
    const videos = await fetchPlaylistVideos('UUabc', { fetchFn: fakeFetch });
    expect(videos[0]?.publishedAt.toISOString()).toBe('2026-05-10T00:00:00.000Z');
  });

  it('falls back to snippet.publishedAt when contentDetails is missing', async () => {
    const fakeFetch: typeof fetch = async () =>
      jsonResponse({
        items: [
          {
            snippet: {
              title: 't',
              description: 'd',
              publishedAt: '2026-04-15T00:00:00Z',
              videoOwnerChannelId: 'UCowner',
              resourceId: { videoId: 'v1' },
            },
            // no contentDetails — never-public videos or partial response
          },
        ],
      });
    const videos = await fetchPlaylistVideos('UUabc', { fetchFn: fakeFetch });
    expect(videos[0]?.publishedAt.toISOString()).toBe('2026-04-15T00:00:00.000Z');
  });

  it('skips videos with videoPublishedAt < since but continues paginating', async () => {
    // `since` is a filter, NOT an early-stop. A first-page item with
    // videoPublishedAt before the window is dropped, and we still fetch
    // page 2 (which may hold scheduled→public items, see next test).
    let call = 0;
    const fakeFetch: typeof fetch = async () => {
      call += 1;
      if (call === 1) {
        return jsonResponse({
          items: [
            {
              snippet: {
                title: 'old',
                description: 'd',
                publishedAt: '2025-12-01T00:00:00Z',
                videoOwnerChannelId: 'UCowner',
                resourceId: { videoId: 'old1' },
              },
              contentDetails: { videoPublishedAt: '2025-12-01T00:00:00Z' },
            },
          ],
          nextPageToken: 'PG2',
        });
      }
      return jsonResponse({
        items: [mkItem('v2', 'in-window', '2026-05-10T00:00:00Z')],
      });
    };
    const videos = await fetchPlaylistVideos('UUabc', {
      fetchFn: fakeFetch,
      since: new Date('2026-05-01T00:00:00Z'),
    });
    expect(call).toBe(2);
    expect(videos.map((v) => v.videoId)).toEqual(['v2']);
  });

  it('includes scheduled→public videos whose playlist-add time is outside since', async () => {
    // Page 2 holds a video added 18 months ago as private, made public
    // last week. snippet.publishedAt < since but
    // contentDetails.videoPublishedAt > since. Backfill MUST include it;
    // this is the exact scenario the early-stop bug used to drop.
    let call = 0;
    const fakeFetch: typeof fetch = async () => {
      call += 1;
      if (call === 1) {
        return jsonResponse({
          items: [mkItem('v1', 'recent', '2026-05-10T00:00:00Z')],
          nextPageToken: 'PG2',
        });
      }
      return jsonResponse({
        items: [
          {
            snippet: {
              title: 'long-private',
              description: 'd',
              publishedAt: '2024-11-01T00:00:00Z', // added 18mo ago
              videoOwnerChannelId: 'UCowner',
              resourceId: { videoId: 'scheduled1' },
            },
            contentDetails: { videoPublishedAt: '2026-05-09T00:00:00Z' }, // public last week
          },
        ],
      });
    };
    const videos = await fetchPlaylistVideos('UUabc', {
      fetchFn: fakeFetch,
      since: new Date('2026-05-01T00:00:00Z'),
    });
    expect(call).toBe(2);
    expect(videos.map((v) => v.videoId)).toEqual(['v1', 'scheduled1']);
    expect(videos[1]?.publishedAt.toISOString()).toBe('2026-05-09T00:00:00.000Z');
  });

  it('respects maxItems cap', async () => {
    const fakeFetch: typeof fetch = async () =>
      jsonResponse({
        items: Array.from({ length: 5 }, (_, i) =>
          mkItem(`v${i}`, `t${i}`, `2026-05-${(10 - i).toString().padStart(2, '0')}T00:00:00Z`),
        ),
        nextPageToken: 'PG2',
      });
    const videos = await fetchPlaylistVideos('UUabc', { fetchFn: fakeFetch, maxItems: 3 });
    expect(videos).toHaveLength(3);
  });

  it('throws on non-2xx with masked URL', async () => {
    const fakeFetch: typeof fetch = async () => new Response('quota exceeded', { status: 403 });
    await expect(fetchPlaylistVideos('UUabc', { fetchFn: fakeFetch })).rejects.toThrow(
      /HTTP 403/,
    );
    // The masking check — error message should NOT contain the API key.
    try {
      await fetchPlaylistVideos('UUabc', { fetchFn: fakeFetch });
    } catch (e) {
      expect((e as Error).message).not.toContain('AIzaSyTEST');
      expect((e as Error).message).toContain('key=***');
    }
  });
});

describe('fetchChannelVideosSince (composite)', () => {
  it('resolves handle, derives uploads playlist id, paginates', async () => {
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/channels?')) {
        return jsonResponse({ items: [{ id: 'UCabcdefghijklmnopqrstuv' }] });
      }
      // playlistItems
      return jsonResponse({
        items: [mkItem('v1', 'recent', '2026-05-10T00:00:00Z')],
      });
    };
    const videos = await fetchChannelVideosSince(
      '@leesimon',
      new Date('2026-05-01T00:00:00Z'),
      { fetchFn: fakeFetch },
    );
    expect(videos.map((v) => v.videoId)).toEqual(['v1']);
    expect(calls[0]).toContain('forHandle=%40leesimon');
    // Playlist id is derived: UCabc... → UUabc...
    expect(calls[1]).toContain('playlistId=UUabcdefghijklmnopqrstuv');
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mkItem(videoId: string, title: string, publishedAt: string) {
  // For typical uploads, contentDetails.videoPublishedAt matches
  // snippet.publishedAt. Tests that exercise divergence pass an inline
  // item literal instead of using this helper.
  return {
    snippet: {
      title,
      description: `desc for ${title}`,
      publishedAt,
      videoOwnerChannelId: 'UCowner',
      resourceId: { videoId },
    },
    contentDetails: { videoPublishedAt: publishedAt },
  };
}
