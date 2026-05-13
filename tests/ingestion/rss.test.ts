// Adapter tests against frozen fixture XML strings — no network, no DB.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseRssXml } from '../../src/ingestion/rss.js';

function fixture(name: string): string {
  return readFileSync(resolve(__dirname, 'fixtures', name), 'utf-8');
}

describe('parseRssXml — RSS 2.0 news', () => {
  it('returns one row per item with stable shape', async () => {
    const items = await parseRssXml(fixture('rss20-news.xml'));
    expect(items.length).toBe(2);
    const [first] = items;
    expect(first?.title).toBe('Headline one — about something important');
    expect(first?.url).toContain('news.example.com/articles/headline-one');
    expect(first?.externalId).toBe('news-example:headline-one');
    expect(first?.author).toBe('Jane Reporter');
    expect(first?.language).toBeNull();
    expect(first?.publishedAt).toBeInstanceOf(Date);
    expect(first?.publishedAt.toISOString()).toBe('2026-05-12T14:30:00.000Z');
  });
});

describe('parseRssXml — Atom blog', () => {
  it('parses Atom <entry> elements equivalently', async () => {
    const items = await parseRssXml(fixture('atom-blog.xml'));
    expect(items.length).toBe(1);
    const [entry] = items;
    expect(entry?.title).toBe('Atom post about a topic');
    expect(entry?.url).toBe('https://blog.example.com/posts/atom-post');
    expect(entry?.externalId).toBe('tag:blog.example.com,2026:atom-post');
    expect(entry?.author).toBe('Anna Author');
  });
});

describe('parseRssXml — podcast feed', () => {
  it('captures show notes via description (title + show notes only in v1)', async () => {
    const items = await parseRssXml(fixture('rss20-podcast.xml'));
    expect(items.length).toBe(1);
    const [ep] = items;
    expect(ep?.title).toBe('Episode 42: the meaning of feeds');
    expect(ep?.content).toContain('RSS, Atom, and the no-scraping policy');
    // enclosure round-trips into rawMeta for downstream (audio transcription
    // wires up Phase 2 PR 1 per ADR-006).
    expect(ep?.rawMeta.enclosure).toMatchObject({
      url: 'https://podcast.example.com/audio/ep42.mp3',
      type: 'audio/mpeg',
    });
  });
});

describe('parseRssXml — items missing required fields', () => {
  it('skips items without a link', async () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>x</title><link>https://x.example/</link><description>x</description>
<item><title>no link</title><description>oops</description><pubDate>Mon, 12 May 2026 12:00:00 GMT</pubDate></item>
<item><title>ok</title><link>https://x.example/ok</link><description>fine</description><pubDate>Mon, 12 May 2026 12:01:00 GMT</pubDate></item>
</channel></rss>`;
    const items = await parseRssXml(xml);
    expect(items.length).toBe(1);
    expect(items[0]?.title).toBe('ok');
  });

  it('skips items without a title', async () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>x</title><link>https://x.example/</link><description>x</description>
<item><link>https://x.example/no-title</link><description>oops</description><pubDate>Mon, 12 May 2026 12:00:00 GMT</pubDate></item>
</channel></rss>`;
    const items = await parseRssXml(xml);
    expect(items.length).toBe(0);
  });
});
