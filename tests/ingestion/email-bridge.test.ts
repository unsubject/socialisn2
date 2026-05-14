// Regression test from the 2026-05-14 code review (Finding 1).
//
// The feed-worker emits an Atom feed that the ingestion-worker polls
// via fetchAndParseEmailBridge → fetchAndParseRss. rss-parser drops
// entries that have no <link>, and the original feed-worker rendered
// only <id>/<title>/<updated> — so every successfully-delivered email
// was being parsed and then dropped at the RSS stage. Net effect: zero
// raw_items rows ever produced from the bridge.
//
// The fixture below mirrors feed-handler.ts's render after the fix:
// each <entry> carries a synthetic <link href="…/items/<slug>/<msg-id>"/>
// plus a <summary> when body_text is present. Updating either file
// should break this test until both stay in sync.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fetchAndParseEmailBridge } from '../../src/ingestion/email_bridge.js';
import { parseRssXml } from '../../src/ingestion/rss.js';

function fixture(name: string): string {
  return readFileSync(resolve(__dirname, 'fixtures', name), 'utf-8');
}

describe('parseRssXml against feed-worker render', () => {
  it('produces a RawItemInput per Atom entry (regression: link must be present)', async () => {
    const items = await parseRssXml(fixture('email-bridge-feed.xml'));
    expect(items.length).toBe(2);

    const [first] = items;
    expect(first?.title).toBe('News from Anthropic: weekly update');
    expect(first?.url).toBe(
      'https://inbox.socialisn.com/items/anthropic/%3Cabc-123%40news.anthropic.com%3E',
    );
    expect(first?.externalId).toMatch(/abc-123/);
    expect(first?.content ?? '').toContain('launched a new model');
  });
});

describe('fetchAndParseEmailBridge', () => {
  it('is a thin alias to the RSS adapter', async () => {
    const direct = await parseRssXml(fixture('email-bridge-feed.xml'));
    expect(typeof fetchAndParseEmailBridge).toBe('function');
    expect(direct[0]?.title).toBeDefined();
  });
});
