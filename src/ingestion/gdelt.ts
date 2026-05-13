// GDELT GKG enrichment adapter (SPEC §6.8). On-demand per cluster, 6h cache.
// Triggered from Phase 3 scoring — this file just exposes the primitives.
//
// Output shape mirrors `gdelt_coverage`: first-seen / counts / outlets /
// themes. The lookupOrFetchCoverage helper handles cache + write in one
// call, so the scoring stage doesn't see the network boundary.
//
// Failure model: any non-OK HTTP response throws (caller logs + decides).
// No BigQuery fallback in v1 per ADR-005.

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

export function buildGkgUrl(input: GdeltQueryInput): string {
  const params = new URLSearchParams({
    query: input.query,
    mode: 'ArtList',
    maxrecords: String(GKG_MAX_RECORDS),
    format: 'json',
    startdatetime: toGkgDateTime(input.startDate),
    enddatetime: toGkgDateTime(input.endDate),
  });
  return `${GKG_BASE}?${params.toString()}`;
}

interface GdeltArticle {
  url?: string;
  title?: string;
  seendate?: string;
  language?: string;
  sourcecountry?: string;
  sourcecommonname?: string;
  themes?: string;
}

interface GdeltArtListResponse {
  articles?: GdeltArticle[];
}

function parseGkgSeenDate(s: string): Date | null {
  // GDELT seendate format: `YYYYMMDDTHHMMSSZ`
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function summariseGkgArtList(
  response: GdeltArtListResponse,
): GdeltCoverageResult {
  const articles = response.articles ?? [];
  if (articles.length === 0) {
    return {
      firstSeenGdelt: null,
      totalArticleCount: 0,
      countryCount: 0,
      languageCount: 0,
      sourceOutlets: [],
      themes: [],
    };
  }

  const countries = new Set<string>();
  const languages = new Set<string>();
  const outlets = new Map<string, number>();
  const themes = new Map<string, number>();
  let firstSeen: Date | null = null;

  for (const a of articles) {
    if (a.sourcecountry) countries.add(a.sourcecountry);
    if (a.language) languages.add(a.language);
    if (a.sourcecommonname) {
      outlets.set(a.sourcecommonname, (outlets.get(a.sourcecommonname) ?? 0) + 1);
    }
    if (a.themes) {
      for (const raw of a.themes.split(';')) {
        const t = raw.trim();
        if (t) themes.set(t, (themes.get(t) ?? 0) + 1);
      }
    }
    if (a.seendate) {
      const seen = parseGkgSeenDate(a.seendate);
      if (seen && (firstSeen === null || seen < firstSeen)) firstSeen = seen;
    }
  }

  const rank = (m: Map<string, number>): string[] =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N).map(([k]) => k);

  return {
    firstSeenGdelt: firstSeen,
    totalArticleCount: articles.length,
    countryCount: countries.size,
    languageCount: languages.size,
    sourceOutlets: rank(outlets),
    themes: rank(themes),
  };
}

export async function fetchGkg(input: GdeltQueryInput): Promise<GdeltCoverageResult> {
  const url = buildGkgUrl(input);
  const res = await fetch(url, {
    headers: { 'User-Agent': env.gdeltUserAgent() },
    signal: AbortSignal.timeout(env.httpTimeoutMs()),
  });
  if (!res.ok) {
    throw new Error(`GDELT GKG returned ${res.status} ${res.statusText}`);
  }
  // GDELT occasionally returns empty body or malformed JSON under load — let
  // the JSON parse error surface, caller treats as a transient failure.
  const json = (await res.json()) as GdeltArtListResponse;
  return summariseGkgArtList(json);
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
