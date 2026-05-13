// arXiv RSS 1.0 (RDF) fixture-based test. arXiv exposes RDF, not RSS 2.0;
// the adapter delegates to fetchAndParseRss, so this test verifies that
// rss-parser handles RDF in the way the adapter assumes.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseRssXml } from '../../src/ingestion/rss.js';

function fixture(name: string): string {
  return readFileSync(resolve(__dirname, 'fixtures', name), 'utf-8');
}

describe('parseRssXml — arXiv RDF', () => {
  it('parses RDF items into the standard RawItemInput shape', async () => {
    const items = await parseRssXml(fixture('arxiv-rdf.xml'));
    expect(items.length).toBe(2);
    const [first] = items;
    expect(first?.title).toBe(
      'Sparse attention scaling laws for long-context reasoning',
    );
    expect(first?.url).toBe('http://arxiv.org/abs/2505.12345');
    expect(first?.author).toContain('Jane Smith');
    expect(first?.content).toContain('sparse attention');
  });

  it('produces a stable externalId for each paper', async () => {
    const items = await parseRssXml(fixture('arxiv-rdf.xml'));
    const ids = items.map((i) => i.externalId);
    expect(new Set(ids).size).toBe(2);
    // rss-parser surfaces RDF's rdf:about as the guid, but format varies by
    // version. The adapter falls back to the link, so externalId should at
    // worst equal the link.
    expect(ids[0]?.length).toBeGreaterThan(0);
  });
});
