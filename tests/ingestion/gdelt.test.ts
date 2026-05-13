// Pure-function tests for the GDELT adapter: URL builder, date formatter,
// query-hash determinism, ArtList summariser. Network + cache integration
// covered by tests/ingestion/gdelt-cache.test.ts (real-PG).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildGkgUrl,
  hashGdeltQuery,
  summariseGkgArtList,
  toGkgDateTime,
} from '../../src/ingestion/gdelt.js';

function fixture(name: string): string {
  return readFileSync(resolve(__dirname, 'fixtures', name), 'utf-8');
}

describe('toGkgDateTime', () => {
  it('formats UTC date as YYYYMMDDHHMMSS', () => {
    expect(toGkgDateTime(new Date('2026-05-12T09:08:07Z'))).toBe('20260512090807');
  });

  it('zero-pads single-digit components', () => {
    expect(toGkgDateTime(new Date('2026-01-02T03:04:05Z'))).toBe('20260102030405');
  });
});

describe('buildGkgUrl', () => {
  it('encodes the query + date params correctly', () => {
    const url = buildGkgUrl({
      query: 'Federal Reserve',
      startDate: new Date('2026-05-12T00:00:00Z'),
      endDate: new Date('2026-05-13T00:00:00Z'),
    });
    expect(url).toContain('https://api.gdeltproject.org/api/v2/doc/doc?');
    expect(url).toContain('query=Federal+Reserve');
    expect(url).toContain('mode=ArtList');
    expect(url).toContain('maxrecords=250');
    expect(url).toContain('format=json');
    expect(url).toContain('startdatetime=20260512000000');
    expect(url).toContain('enddatetime=20260513000000');
  });
});

describe('hashGdeltQuery', () => {
  const start = new Date('2026-05-12T00:00:00Z');
  const end = new Date('2026-05-13T00:00:00Z');

  it('is deterministic', () => {
    const a = hashGdeltQuery({ query: 'Fed', startDate: start, endDate: end });
    const b = hashGdeltQuery({ query: 'Fed', startDate: start, endDate: end });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('normalises case + whitespace', () => {
    const a = hashGdeltQuery({ query: 'Federal  Reserve', startDate: start, endDate: end });
    const b = hashGdeltQuery({ query: 'federal reserve', startDate: start, endDate: end });
    expect(a).toBe(b);
  });

  it('changes when the date window moves', () => {
    const a = hashGdeltQuery({ query: 'Fed', startDate: start, endDate: end });
    const b = hashGdeltQuery({
      query: 'Fed',
      startDate: start,
      endDate: new Date('2026-05-14T00:00:00Z'),
    });
    expect(a).not.toBe(b);
  });
});

describe('summariseGkgArtList', () => {
  it('returns zero-coverage for an empty article list', () => {
    expect(summariseGkgArtList({ articles: [] })).toEqual({
      firstSeenGdelt: null,
      totalArticleCount: 0,
      countryCount: 0,
      languageCount: 0,
      sourceOutlets: [],
      themes: [],
    });
  });

  it('tolerates a missing articles field', () => {
    expect(summariseGkgArtList({})).toEqual({
      firstSeenGdelt: null,
      totalArticleCount: 0,
      countryCount: 0,
      languageCount: 0,
      sourceOutlets: [],
      themes: [],
    });
  });

  it('aggregates counts + earliest-seen + outlet / theme rankings from a fixture response', () => {
    const json = JSON.parse(fixture('gdelt-artlist.json'));
    const coverage = summariseGkgArtList(json);
    expect(coverage.totalArticleCount).toBe(5);
    expect(coverage.countryCount).toBe(3);
    expect(coverage.languageCount).toBe(2);
    // Reuters appears twice; ranks first.
    expect(coverage.sourceOutlets[0]).toBe('Reuters');
    expect(coverage.sourceOutlets).toContain('Bloomberg');
    expect(coverage.sourceOutlets).toContain('Financial Times');
    // ECON_CENTRALBANK appears in 4/5 articles; ranks first.
    expect(coverage.themes[0]).toBe('ECON_CENTRALBANK');
    // FT article at 2026-05-11T23:00:00Z is earliest.
    expect(coverage.firstSeenGdelt?.toISOString()).toBe('2026-05-11T23:00:00.000Z');
  });

  it('skips malformed seendate values', () => {
    const coverage = summariseGkgArtList({
      articles: [
        {
          seendate: 'not-a-date',
          sourcecountry: 'X',
          language: 'English',
          sourcecommonname: 'X News',
        },
      ],
    });
    expect(coverage.firstSeenGdelt).toBeNull();
    expect(coverage.totalArticleCount).toBe(1);
  });
});
