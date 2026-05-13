// Pure-function tests for the GDELT adapter. Two-fetch network model
// (TimelineVolRaw + ArtList) is exercised by gdelt-cache.test.ts.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildGkgArtListUrl,
  buildGkgTimelineUrl,
  hashGdeltQuery,
  summariseGkgArtList,
  summariseGkgTimeline,
  toGkgDateTime,
} from '../../src/ingestion/gdelt.js';

function fixture(name: string): string {
  return readFileSync(resolve(__dirname, 'fixtures', name), 'utf-8');
}

const start = new Date('2026-05-12T00:00:00Z');
const end = new Date('2026-05-13T00:00:00Z');

describe('toGkgDateTime', () => {
  it('formats UTC date as YYYYMMDDHHMMSS', () => {
    expect(toGkgDateTime(new Date('2026-05-12T09:08:07Z'))).toBe('20260512090807');
  });

  it('zero-pads single-digit components', () => {
    expect(toGkgDateTime(new Date('2026-01-02T03:04:05Z'))).toBe('20260102030405');
  });
});

describe('buildGkgArtListUrl', () => {
  it('encodes query + date + ArtList mode params', () => {
    const url = buildGkgArtListUrl({ query: 'Federal Reserve', startDate: start, endDate: end });
    expect(url).toContain('mode=ArtList');
    expect(url).toContain('maxrecords=250');
    expect(url).toContain('query=Federal+Reserve');
    expect(url).toContain('startdatetime=20260512000000');
    expect(url).toContain('enddatetime=20260513000000');
    expect(url).toContain('format=json');
  });
});

describe('buildGkgTimelineUrl', () => {
  it('encodes query + date + TimelineVolRaw mode, no maxrecords', () => {
    const url = buildGkgTimelineUrl({ query: 'Federal Reserve', startDate: start, endDate: end });
    expect(url).toContain('mode=TimelineVolRaw');
    expect(url).not.toContain('maxrecords');
    expect(url).toContain('query=Federal+Reserve');
    expect(url).toContain('startdatetime=20260512000000');
    expect(url).toContain('enddatetime=20260513000000');
  });
});

describe('hashGdeltQuery', () => {
  it('is deterministic + 64-char hex', () => {
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

describe('summariseGkgArtList — sample-based distribution', () => {
  it('returns zero-sample for an empty article list', () => {
    expect(summariseGkgArtList({ articles: [] })).toEqual({
      sampleCount: 0,
      countryCount: 0,
      languageCount: 0,
      sourceOutlets: [],
    });
  });

  it('tolerates a missing articles field', () => {
    expect(summariseGkgArtList({})).toEqual({
      sampleCount: 0,
      countryCount: 0,
      languageCount: 0,
      sourceOutlets: [],
    });
  });

  it('aggregates outlets + countries + languages from a fixture sample', () => {
    const json = JSON.parse(fixture('gdelt-artlist.json'));
    const sample = summariseGkgArtList(json);
    expect(sample.sampleCount).toBe(5);
    expect(sample.countryCount).toBe(3);
    expect(sample.languageCount).toBe(2);
    expect(sample.sourceOutlets[0]).toBe('Reuters');
    expect(sample.sourceOutlets).toContain('Bloomberg');
    expect(sample.sourceOutlets).toContain('Financial Times');
  });
});

describe('summariseGkgTimeline — accurate volume / earliest-seen', () => {
  it('returns zero / null for an empty timeline', () => {
    expect(summariseGkgTimeline({ timeline: [] })).toEqual({
      totalArticleCount: 0,
      firstSeenGdelt: null,
    });
  });

  it('sums values across the nested series shape', () => {
    const json = JSON.parse(fixture('gdelt-timeline.json'));
    const summary = summariseGkgTimeline(json);
    // 12 + 0 + 87 + 234 + 612 + 905 = 1850 — uncapped, unlike ArtList.
    expect(summary.totalArticleCount).toBe(1850);
    // The 0-value bucket is skipped; earliest non-zero is 2026-05-11T23:00:00Z.
    expect(summary.firstSeenGdelt?.toISOString()).toBe('2026-05-11T23:00:00.000Z');
  });

  it('handles the flat (no-series) shape', () => {
    const summary = summariseGkgTimeline({
      timeline: [
        { date: '20260512100000', value: 5 },
        { date: '20260512103000', value: 7 },
      ],
    });
    expect(summary.totalArticleCount).toBe(12);
    expect(summary.firstSeenGdelt?.toISOString()).toBe('2026-05-12T10:00:00.000Z');
  });

  it('treats negative or missing values as zero', () => {
    const summary = summariseGkgTimeline({
      timeline: [
        { date: '20260512100000' },
        { date: '20260512103000', value: -3 },
        { date: '20260512110000', value: 10 },
      ],
    });
    expect(summary.totalArticleCount).toBe(10);
    expect(summary.firstSeenGdelt?.toISOString()).toBe('2026-05-12T11:00:00.000Z');
  });

  it('also accepts the YYYYMMDDTHHMMSSZ separator variant', () => {
    const summary = summariseGkgTimeline({
      timeline: [{ date: '20260512T100000Z', value: 3 }],
    });
    expect(summary.firstSeenGdelt?.toISOString()).toBe('2026-05-12T10:00:00.000Z');
  });
});
