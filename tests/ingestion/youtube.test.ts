// YouTube channel-feed fixture test. Verifies the customField bindings for
// yt:videoId and media:group/media:description work as the adapter assumes.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildChannelFeedUrl, parseYouTubeXml } from '../../src/ingestion/youtube.js';

function fixture(name: string): string {
  return readFileSync(resolve(__dirname, 'fixtures', name), 'utf-8');
}

describe('buildChannelFeedUrl', () => {
  it('formats the feed URL with the channel id', () => {
    expect(buildChannelFeedUrl('UCexample')).toBe(
      'https://www.youtube.com/feeds/videos.xml?channel_id=UCexample',
    );
  });

  it('URL-encodes channel-id values', () => {
    expect(buildChannelFeedUrl('UC with space')).toBe(
      'https://www.youtube.com/feeds/videos.xml?channel_id=UC%20with%20space',
    );
  });
});

describe('parseYouTubeXml', () => {
  it('extracts videoId / title / description / publishedAt per entry', async () => {
    const videos = await parseYouTubeXml(fixture('youtube-channel.xml'));
    expect(videos.length).toBe(2);

    const [first, second] = videos;
    expect(first?.externalId).toBe('VIDEO_AAA');
    expect(first?.url).toBe('https://www.youtube.com/watch?v=VIDEO_AAA');
    expect(first?.title).toBe('Episode one: the news today');
    expect(first?.description).toContain('central bank decision');
    expect(first?.publishedAt.toISOString()).toBe('2026-05-12T12:00:00.000Z');

    expect(second?.externalId).toBe('VIDEO_BBB');
    expect(second?.publishedAt.toISOString()).toBe('2026-05-11T12:00:00.000Z');
  });

  it('skips entries with no videoId', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns:media="http://search.yahoo.com/mrss/"
      xmlns="http://www.w3.org/2005/Atom">
  <id>yt:channel:UCx</id>
  <title>x</title>
  <entry>
    <id>yt:video:OK</id>
    <yt:videoId>OK</yt:videoId>
    <title>good</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=OK"/>
    <published>2026-05-12T12:00:00+00:00</published>
    <media:group><media:description>fine</media:description></media:group>
  </entry>
  <entry>
    <id>tag:notyoutube:1</id>
    <title>no videoId</title>
    <link rel="alternate" href="https://example.com/watch"/>
    <published>2026-05-12T12:00:00+00:00</published>
  </entry>
</feed>`;
    const videos = await parseYouTubeXml(xml);
    expect(videos.length).toBe(1);
    expect(videos[0]?.externalId).toBe('OK');
  });
});
