// Pure-function tests for the SPEC §7.2 step-1 hash primitives.

import { describe, expect, it } from 'vitest';

import {
  canonicaliseUrl,
  normaliseTitle,
  titleHash,
  urlHash,
} from '../../src/ingestion/dedup.js';

describe('canonicaliseUrl', () => {
  it('strips utm_* tracking params', () => {
    const a = 'https://example.com/post?utm_source=rss&utm_medium=feed&id=42';
    const b = 'https://example.com/post?id=42';
    expect(canonicaliseUrl(a)).toBe(canonicaliseUrl(b));
  });

  it('lower-cases scheme and host', () => {
    expect(canonicaliseUrl('HTTPS://Example.COM/Path')).toBe('https://example.com/Path');
  });

  it('drops fragments', () => {
    expect(canonicaliseUrl('https://example.com/post#section-2')).toBe(
      'https://example.com/post',
    );
  });

  it('strips trailing slash but preserves root', () => {
    expect(canonicaliseUrl('https://example.com/post/')).toBe('https://example.com/post');
    expect(canonicaliseUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('strips fbclid / gclid / mc_cid / ref', () => {
    const u =
      'https://example.com/p?fbclid=abc&gclid=def&mc_cid=ghi&ref=newsletter&keep=yes';
    expect(canonicaliseUrl(u)).toBe('https://example.com/p?keep=yes');
  });

  it("strips BBC's at_* tracking params", () => {
    const u =
      'https://www.bbc.com/news/articles/c1w28qw1e0xo?at_medium=RSS&at_campaign=rss&at_link_origin=feed';
    expect(canonicaliseUrl(u)).toBe(
      'https://bbc.com/news/articles/c1w28qw1e0xo',
    );
  });

  it('strips a leading www. so example.com and www.example.com share a hash', () => {
    expect(canonicaliseUrl('https://www.example.com/x')).toBe(
      canonicaliseUrl('https://example.com/x'),
    );
    // Does NOT strip other subdomains.
    expect(canonicaliseUrl('https://m.example.com/x')).not.toBe(
      canonicaliseUrl('https://example.com/x'),
    );
  });

  it('sorts query params alphabetically so order-only variants share a hash', () => {
    expect(canonicaliseUrl('https://example.com/x?b=2&a=1')).toBe(
      canonicaliseUrl('https://example.com/x?a=1&b=2'),
    );
    // Preserves duplicate keys + multi-value params, just in sorted-key order.
    expect(canonicaliseUrl('https://example.com/x?c=3&a=1&b=2')).toBe(
      'https://example.com/x?a=1&b=2&c=3',
    );
  });

  it('falls back to a trimmed string for malformed input', () => {
    expect(canonicaliseUrl('  /relative/path  ')).toBe('/relative/path');
  });
});

describe('normaliseTitle', () => {
  it('collapses unicode punctuation variants', () => {
    expect(normaliseTitle('Reuters — Big news')).toBe('reuters big news');
    expect(normaliseTitle('Reuters – Big news')).toBe('reuters big news');
    expect(normaliseTitle('Reuters - Big news')).toBe('reuters big news');
  });

  it('collapses runs of whitespace', () => {
    expect(normaliseTitle('Big   News \t Today')).toBe('big news today');
  });

  it('produces the same hash for punctuation variants', () => {
    expect(titleHash('Reuters — Big news')).toBe(titleHash('reuters big news'));
  });
});

describe('urlHash / titleHash', () => {
  it('produces 64-char sha256 hex digests', () => {
    expect(urlHash('https://example.com/x')).toMatch(/^[0-9a-f]{64}$/);
    expect(titleHash('hello world')).toMatch(/^[0-9a-f]{64}$/);
  });
});
