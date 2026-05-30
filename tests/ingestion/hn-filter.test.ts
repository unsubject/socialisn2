// Pure-function tests for src/ingestion/hn-filter.ts. No DB, no HTTP.

import { describe, expect, it } from 'vitest';

import {
  applyDomainWhitelist,
  filterHnIngestion,
  isHnSourceUrl,
} from '../../src/ingestion/hn-filter.js';
import type { RawItemInput } from '../../src/ingestion/types.js';

function mkItem(url: string, overrides: Partial<RawItemInput> = {}): RawItemInput {
  return {
    externalId: `id-${url}`,
    url,
    title: 'irrelevant',
    content: null,
    author: null,
    publishedAt: new Date('2026-05-30T00:00:00Z'),
    language: null,
    rawMeta: {},
    ...overrides,
  };
}

describe('isHnSourceUrl', () => {
  it('matches the v1 hnrss.org feed URL', () => {
    expect(isHnSourceUrl('https://hnrss.org/best?points=100')).toBe(true);
  });

  it('matches news.ycombinator.com (defensive — if a future seed switches)', () => {
    expect(isHnSourceUrl('https://news.ycombinator.com/rss')).toBe(true);
  });

  it('does NOT match generic publisher RSS', () => {
    expect(isHnSourceUrl('https://www.theguardian.com/rss')).toBe(false);
    expect(isHnSourceUrl('https://www.nytimes.com/services/xml/rss/nyt/HomePage.xml')).toBe(
      false,
    );
    expect(isHnSourceUrl('https://feeds.arstechnica.com/arstechnica/index')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isHnSourceUrl('HTTPS://HNRSS.ORG/best')).toBe(true);
  });

  it('returns false on malformed input', () => {
    // We don't crash — the worker would surface the empty result as
    // "passed through" since !isHnSourceUrl. Callers see no filter.
    expect(isHnSourceUrl('')).toBe(false);
    expect(isHnSourceUrl('not a url')).toBe(false);
  });
});

describe('applyDomainWhitelist', () => {
  it('keeps an item whose host is a whitelisted apex', () => {
    const items = [mkItem('https://www.nytimes.com/2026/05/30/world/something.html')];
    const result = applyDomainWhitelist(items);
    expect(result.kept).toHaveLength(1);
    expect(result.droppedCount).toBe(0);
  });

  it('keeps an item on a subdomain of a whitelisted apex', () => {
    // Match semantics: ANY subdomain of `nytimes.com` is allowed.
    const items = [mkItem('https://dealbook.nytimes.com/post/abc')];
    const result = applyDomainWhitelist(items);
    expect(result.kept).toHaveLength(1);
  });

  it('drops an item whose host is not on the whitelist', () => {
    const items = [mkItem('https://github.com/some/repo/pull/123')];
    const result = applyDomainWhitelist(items);
    expect(result.kept).toHaveLength(0);
    expect(result.droppedCount).toBe(1);
  });

  it('drops an item with a malformed URL', () => {
    const items = [mkItem('not-a-url-just-some-text')];
    const result = applyDomainWhitelist(items);
    expect(result.kept).toHaveLength(0);
    expect(result.droppedCount).toBe(1);
  });

  it('mixed batch — keeps whitelist, drops non-whitelist, preserves order', () => {
    const items = [
      mkItem('https://www.theguardian.com/world/1'),
      mkItem('https://random-personal-blog.example/post'),
      mkItem('https://arstechnica.com/tech-policy/2'),
      mkItem('https://lkml.org/lkml/3'),
      mkItem('https://www.bloomberg.com/news/4'),
    ];
    const result = applyDomainWhitelist(items);
    expect(result.kept.map((i) => i.url)).toEqual([
      'https://www.theguardian.com/world/1',
      'https://arstechnica.com/tech-policy/2',
      'https://www.bloomberg.com/news/4',
    ]);
    expect(result.droppedCount).toBe(2);
  });

  it('rejects a suffix-spoofing attempt (apex appears mid-host, not at end)', () => {
    // `nytimes.com.evil.example` must NOT match `nytimes.com`. This is
    // the classic "right-anchored" subdomain check.
    const items = [mkItem('https://nytimes.com.evil.example/article')];
    const result = applyDomainWhitelist(items);
    expect(result.kept).toHaveLength(0);
    expect(result.droppedCount).toBe(1);
  });

  it('returns an empty kept array on an empty input', () => {
    const result = applyDomainWhitelist([]);
    expect(result.kept).toEqual([]);
    expect(result.droppedCount).toBe(0);
  });
});

describe('filterHnIngestion (integration entry point)', () => {
  it('passes non-HN sources through unchanged', () => {
    const items = [
      mkItem('https://github.com/some/repo'),
      mkItem('https://random-blog.example/x'),
    ];
    const result = filterHnIngestion('https://www.theguardian.com/rss', items);
    // Non-HN sources are operator-curated and the filter must not strip
    // them — this is the contract the worker relies on.
    expect(result.kept).toEqual(items);
    expect(result.droppedCount).toBe(0);
  });

  it('applies the whitelist when the source URL is HN', () => {
    const items = [
      mkItem('https://www.nytimes.com/2026/05/30/world/a.html'),
      mkItem('https://github.com/some/repo'),
      mkItem('https://arstechnica.com/post/b'),
    ];
    const result = filterHnIngestion('https://hnrss.org/best?points=100', items);
    expect(result.kept.map((i) => i.url)).toEqual([
      'https://www.nytimes.com/2026/05/30/world/a.html',
      'https://arstechnica.com/post/b',
    ]);
    expect(result.droppedCount).toBe(1);
  });

  it('handles the empty-items case (e.g. feed returned 0 stories)', () => {
    expect(filterHnIngestion('https://hnrss.org/best', [])).toEqual({
      kept: [],
      droppedCount: 0,
    });
  });
});
