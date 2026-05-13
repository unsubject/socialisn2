// GDELT GKG enrichment adapter (SPEC §6.8). On-demand per cluster, 6h cache.
// Triggered from Phase 3 scoring — this file just exposes the primitives.
//
// Output shape mirrors `gdelt_coverage`. The lookupOrFetchCoverage helper
// handles cache + write in one call, so the scoring stage doesn't see the
// network boundary.
//
// Two-fetch model. DOC API has no single endpoint that returns both accurate
// volume metrics and per-article distribution, so we combine two modes:
//
//   - `mode=TimelineVolRaw` returns per-15-min-bucket raw article counts
//     across the full window — drives totalArticleCount (sum) and
//     firstSeenGdelt (earliest non-zero bucket). Not capped at 250.
//
//   - `mode=ArtList&maxrecords=250` returns up to 250 article records —
//     drives the sample-based distribution (countryCount, languageCount,
//     sourceOutlets). For high-volume stories this is a representative
//     250-article sample, not a full enumeration; the cardinality estimators
//     converge fast and 250 is the GDELT cap.
//
// `themes` is intentionally deferred. The DOC API's ArtList does NOT return
// the GKG themes field — themes live in the GKG raw CSV files / BigQuery
// export, not in DOC responses. Per ADR-005 + ADR-005 Addendum the themes
// column on gdelt_coverage stays empty in v1; populating it requires the v2
// BigQuery loader (same threshold to trigger as the rate-limit fallback).
//
// Failure model: any non-OK HTTP response throws (caller logs + decides).

import { createHash } from 'node:crypto';

import { and, desc, eq, gte } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { env } from '../config/env.js';
import type { Db } from '../db/client.js';
import { gdeltCoverage } from '../db/schema.js';

const GKG_BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';
const GKG_MAX_RECORDS = 250;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TOP_N = 20;

export interface GdeltCoverageResult {
  firstSeenGdelt: Date | null;
  totalArticleCount: number;
  countryCount: number;
  languageCount: number;
  sourceOutlets: string[];
  /**
   * v1: always empty. GKG themes require BigQuery / raw GKG CSV; the DOC API
   * ArtList endpoint does not return them. Kept as a column on gdelt_coverage
   * so the v2 BigQuery loader can populate it without a schema change.
   */
  themes: string[];
}

export interface GdeltQueryInput {
  query: string;
  startDate: Date;
  endDate: Date;
}

export function hashGdeltQuery(input: GdeltQueryInput): string {
  // Whitespace + case normalisation so semantically-identical queries share
  // a cache row; date range is part of the key so a "rolling 7d" lookup on
  // day N+1 misses the day-N row (correct behaviour — the window moved).
  const canonical = JSON.stringify({
    query: input.query.trim().toLowerCase().replace(/\s+/g, ' '),
    startDate: input.startDate.toISOString(),
    endDate: input.endDate.toISOString(),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function toGkgDateTime(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`
  );
}

function buildBaseParams(input: GdeltQueryInput): URLSearchParams {
  return new URLSearchParams({
    query: input.query,
    format: 'json',
    startdatetime: toGkgDateTime(input.startDate),
    enddatetime: toGkgDateTime(input.endDate),
  });
}

export function buildGkgArtListUrl(input: GdeltQueryInput): string {
  const params = buildBaseParams(input);
  params.set('mode', 'ArtList');
  params.set('maxrecords', String(GKG_MAX_RECORDS));
  return `${GKG_BASE}?${params.toString()}`;
}

export function buildGkgTimelineUrl(input: GdeltQueryInput): string {
  const params = buildBaseParams(input);
  params.set('mode', 'TimelineVolRaw');
  return `${GKG_BASE}?${params.toString()}`;
}

// === Article sample (ArtList) ===

interface GdeltArticle {
  url?: string;
  title?: string;
  language?: string;
  sourcecountry?: string;
  sourcecommonname?: string;
}

interface GdeltArtListResponse {
  articles?: GdeltArticle[];
}

export interface GdeltSampleSummary {
  sampleCount: number;
  countryCount: number;
  languageCount: number;
  sourceOutlets: string[];
}

export function summariseGkgArtList(
  response: GdeltArtListResponse,
): GdeltSampleSummary {
  const articles = response.articles ?? [];
  const countries = new Set<string>();
  const languages = new Set<string>();
  const outlets = new Map<string, number>();

  for (const a of articles) {
    if (a.sourcecountry) countries.add(a.sourcecountry);
    if (a.language) languages.add(a.language);
    if (a.sourcecommonname) {
      outlets.set(a.sourcecommonname, (outlets.get(a.sourcecommonname) ?? 0) + 1);
    }
  }

  const rank = (m: Map<string, number>): string[] =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N).map(([k]) => k);

  return {
    sampleCount: articles.length,
    countryCount: countries.size,
    languageCount: languages.size,
    sourceOutlets: rank(outlets),
  };
}

// === Volume timeline (TimelineVolRaw) ===

interface GdeltTimelinePoint {
  date?: string;
  value?: number;
}

interface GdeltTimelineSeries {
  data?: GdeltTimelinePoint[];
  series?: string;
}

interface GdeltTimelineResponse {
  timeline?: Array<GdeltTimelineSeries | GdeltTimelinePoint>;
}

export interface GdeltTimelineSummary {
  totalArticleCount: number;
  firstSeenGdelt: Date | null;
}

function parseGkgBucketDate(s: string): Date | null {
  // GDELT timeline bucket dates are YYYYMMDDHHMMSS by default; some response
  // shapes include a T separator and trailing Z. Accept either.
  const m = /^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?$/.exec(s);
  if (!m) return null;
  const parsed = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function summariseGkgTimeline(
  response: GdeltTimelineResponse,
): GdeltTimelineSummary {
  // GDELT has shipped two shapes for TimelineVolRaw at different points: a
  // nested `[{ series, data: [{date, value}, …] }]` and a flat `[{date,
  // value}, …]`. Handle both by flattening.
  const series = response.timeline ?? [];
  const points: GdeltTimelinePoint[] = [];
  for (const s of series) {
    if (s && typeof s === 'object' && 'data' in s && Array.isArray(s.data)) {
      for (const p of s.data) points.push(p);
    } else if (s && typeof s === 'object' && 'date' in s) {
      points.push(s as GdeltTimelinePoint);
    }
  }

  let total = 0;
  let firstSeen: Date | null = null;
  for (const p of points) {
    const value = typeof p.value === 'number' ? p.value : 0;
    if (value <= 0) continue;
    total += value;
    if (!p.date) continue;
    const bucket = parseGkgBucketDate(p.date);
    if (bucket && (firstSeen === null || bucket < firstSeen)) {
      firstSeen = bucket;
    }
  }

  return { totalArticleCount: total, firstSeenGdelt: firstSeen };
}

// === Combined fetch ===

export async function fetchGkg(input: GdeltQueryInput): Promise<GdeltCoverageResult> {
  const opts = {
    headers: { 'User-Agent': env.gdeltUserAgent() },
    signal: AbortSignal.timeout(env.httpTimeoutMs()),
  };

  // Two requests; intentionally sequential (not Promise.all) to halve the
  // chance of tripping a rate limit on the second when the first already
  // returned a 429. GDELT serves both modes from the same shared limiter.
  const timelineRes = await fetch(buildGkgTimelineUrl(input), opts);
  if (!timelineRes.ok) {
    throw new Error(
      `GDELT GKG (TimelineVolRaw) returned ${timelineRes.status} ${timelineRes.statusText}`,
    );
  }
  const timeline = summariseGkgTimeline(
    (await timelineRes.json()) as GdeltTimelineResponse,
  );

  const artListRes = await fetch(buildGkgArtListUrl(input), opts);
  if (!artListRes.ok) {
    throw new Error(
      `GDELT GKG (ArtList) returned ${artListRes.status} ${artListRes.statusText}`,
    );
  }
  const sample = summariseGkgArtList(
    (await artListRes.json()) as GdeltArtListResponse,
  );

  return {
    firstSeenGdelt: timeline.firstSeenGdelt,
    totalArticleCount: timeline.totalArticleCount,
    countryCount: sample.countryCount,
    languageCount: sample.languageCount,
    sourceOutlets: sample.sourceOutlets,
    themes: [],
  };
}

export interface CoverageLookupResult {
  coverage: GdeltCoverageResult;
  fromCache: boolean;
}

export async function lookupOrFetchCoverage(
  db: Db,
  clusterId: string | null,
  input: GdeltQueryInput,
): Promise<CoverageLookupResult> {
  const queryHash = hashGdeltQuery(input);
  const cutoff = new Date(Date.now() - CACHE_TTL_MS);

  const [cached] = await db
    .select({
      firstSeenGdelt: gdeltCoverage.firstSeenGdelt,
      totalArticleCount: gdeltCoverage.totalArticleCount,
      countryCount: gdeltCoverage.countryCount,
      languageCount: gdeltCoverage.languageCount,
      sourceOutlets: gdeltCoverage.sourceOutlets,
      themes: gdeltCoverage.themes,
    })
    .from(gdeltCoverage)
    .where(
      and(
        eq(gdeltCoverage.queryHash, queryHash),
        gte(gdeltCoverage.fetchedAt, cutoff),
      ),
    )
    .orderBy(desc(gdeltCoverage.fetchedAt))
    .limit(1);

  if (cached) {
    return {
      coverage: {
        firstSeenGdelt: cached.firstSeenGdelt,
        totalArticleCount: cached.totalArticleCount ?? 0,
        countryCount: cached.countryCount ?? 0,
        languageCount: cached.languageCount ?? 0,
        sourceOutlets: cached.sourceOutlets ?? [],
        themes: cached.themes ?? [],
      },
      fromCache: true,
    };
  }

  const coverage = await fetchGkg(input);
  await db.insert(gdeltCoverage).values({
    id: uuidv7(),
    clusterId,
    queryHash,
    firstSeenGdelt: coverage.firstSeenGdelt,
    totalArticleCount: coverage.totalArticleCount,
    countryCount: coverage.countryCount,
    languageCount: coverage.languageCount,
    sourceOutlets: coverage.sourceOutlets,
    themes: coverage.themes,
  });

  return { coverage, fromCache: false };
}
