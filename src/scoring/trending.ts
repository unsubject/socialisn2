// Trending themes + keywords aggregation over the in-window candidate
// pool. Two surfaces consume this:
//   - the `trending_keywords` MCP tool (on-demand board)
//   - the morning Telegram digest (auto-push) — wired separately
//
// Design notes (see the trending-board PR scope):
//   * THEMES (the editorial `tags`) are the primary axis. Tags are
//     curated at the curate stage, so they de-noise the arXiv/academic
//     flood for free — most ML churn is untagged or only `ai-safety`.
//     KEYWORDS are the secondary detail.
//   * "Trending" is a heat-weighted distinct-CLUSTER count, NOT raw
//     candidate-row frequency. The pipeline re-mints a candidate row
//     for a persisting story on every run and never supersedes the old
//     one, so multiple status='new' rows for one story coexist
//     in-window; and a single high-volume outlet (arXiv) floods many
//     warm clusters. Deduping by cluster_id and weighting hot/rising
//     above warm/declining is what keeps a genuine multi-outlet hot
//     story above the evergreen academic churn.
//   * Weights are named constants, deliberately simple for v1 — tune
//     against a week of real boards rather than guessing finer now.
//   * These are EDITORIAL descriptors for topic timeliness, not
//     platform search-volume / SEO terms (socialisn2 is RSS-only, no
//     platform data). Title/keyword shaping for YouTube/Facebook is a
//     separate, human/on-demand step.

import { sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';

/** Minimal candidate shape the aggregation needs. */
export interface TrendingRow {
  clusterId: string;
  headline: string;
  primaryDomain: string;
  domains: string[];
  temperature: string;
  trajectory: string;
  keywords: string[];
  tags: string[];
}

export interface TrendingEntry {
  /** The tag (theme) or keyword. */
  term: string;
  /** Distinct in-window clusters carrying this term. */
  cluster_count: number;
  /** Heat-weighted score — the ranking key. */
  score: number;
  /** Mean heat (0=cold, 1=warm, 2=over_saturated, 3=hot) of those clusters. */
  mean_heat: number;
  /** Primary domains the term spans. */
  domains: string[];
  /** Headline of the highest-scoring (heat×trajectory) cluster carrying this term. */
  top_headline: string;
}

export interface TrendingBoard {
  /** Distinct in-window clusters considered (post-dedup). */
  cluster_count: number;
  /** Curated editorial themes, ranked. The primary, de-noised axis. */
  themes: TrendingEntry[];
  /** Raw keywords, ranked. Secondary detail. */
  keywords: TrendingEntry[];
}

export interface TrendingOpts {
  /** Restrict to one primary domain. */
  domain?: string;
  /** Max themes and max keywords returned (each). */
  limit?: number;
  /** Min distinct clusters for a KEYWORD to qualify (themes always ≥1). */
  minClusters?: number;
}

// Heat dominates the score so a genuinely spiking story outranks a
// high-volume warm flood. `over_saturated` sits below `hot` — it's
// past peak (already everywhere), so worth less as a fresh angle.
const HEAT_WEIGHT: Record<string, number> = {
  cold: 0.25,
  warm: 1,
  over_saturated: 2,
  hot: 3,
};

// Momentum: rising/peaking beat declining. `new` is the neutral 1.
const TRAJ_WEIGHT: Record<string, number> = {
  new: 1,
  rising: 1.5,
  peaking: 1.25,
  declining: 0.5,
};

// Heat as an ordinal for the mean_heat readout (independent of the
// weight ramp above).
const HEAT_RANK: Record<string, number> = {
  cold: 0,
  warm: 1,
  over_saturated: 2,
  hot: 3,
};

function clusterWeight(row: TrendingRow): number {
  return (HEAT_WEIGHT[row.temperature] ?? 1) * (TRAJ_WEIGHT[row.trajectory] ?? 1);
}

// Lowercase + strip everything but letters/numbers (Unicode-aware, so
// it works for both English and CJK headlines), collapsing whitespace.
// Used as the secondary dedup guard for the rare case where one story
// ends up under two cluster_ids (join-threshold fork / compaction merge).
function normalizeHeadline(headline: string): string {
  return headline.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = raw.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

interface Agg {
  clusterCount: number;
  score: number;
  heatSum: number;
  domains: Set<string>;
  topHeadline: string;
  topWeight: number;
}

function accumulate(
  map: Map<string, Agg>,
  term: string,
  row: TrendingRow,
  weight: number,
  heat: number,
): void {
  let agg = map.get(term);
  if (!agg) {
    agg = {
      clusterCount: 0,
      score: 0,
      heatSum: 0,
      domains: new Set(),
      topHeadline: row.headline,
      topWeight: -Infinity,
    };
    map.set(term, agg);
  }
  agg.clusterCount += 1;
  agg.score += weight;
  agg.heatSum += heat;
  agg.domains.add(row.primaryDomain);
  if (weight > agg.topWeight) {
    agg.topWeight = weight;
    agg.topHeadline = row.headline;
  }
}

function finalize(map: Map<string, Agg>, minClusters: number, limit: number): TrendingEntry[] {
  const entries: TrendingEntry[] = [];
  for (const [term, agg] of map) {
    if (agg.clusterCount < minClusters) continue;
    entries.push({
      term,
      cluster_count: agg.clusterCount,
      score: Math.round(agg.score * 100) / 100,
      mean_heat: Math.round((agg.heatSum / agg.clusterCount) * 100) / 100,
      domains: [...agg.domains].sort(),
      top_headline: agg.topHeadline,
    });
  }
  // Rank by score, then cluster_count, then term (stable + deterministic).
  entries.sort(
    (a, b) =>
      b.score - a.score ||
      b.cluster_count - a.cluster_count ||
      a.term.localeCompare(b.term),
  );
  return entries.slice(0, limit);
}

/**
 * Pure aggregation: rows in (caller orders by created_at DESC so the
 * latest row wins per cluster), ranked board out. No DB — this is the
 * unit-testable core that proves news-grade themes rank above the
 * arXiv flood.
 */
export function computeTrendingFromRows(
  rows: TrendingRow[],
  opts: TrendingOpts = {},
): TrendingBoard {
  const limit = opts.limit ?? 15;
  const minClusters = opts.minClusters ?? 2;

  const scoped = opts.domain ? rows.filter((r) => r.primaryDomain === opts.domain) : rows;

  // Dedup by cluster_id (kills the per-run re-minted duplicates), with
  // a normalized-headline secondary guard for the rare one-story-two-
  // clusters case. First occurrence wins — caller orders latest-first.
  // The headline guard is intentionally lossy: a second cluster whose
  // headline normalizes identically is dropped whole (its tags/keywords
  // discarded), not merged. Acceptable because in-window normalized-
  // headline collisions between genuinely-distinct stories are rare.
  const seenCluster = new Set<string>();
  const seenHeadline = new Set<string>();
  const deduped: TrendingRow[] = [];
  for (const row of scoped) {
    if (seenCluster.has(row.clusterId)) continue;
    const hkey = normalizeHeadline(row.headline);
    if (hkey && seenHeadline.has(hkey)) continue;
    seenCluster.add(row.clusterId);
    if (hkey) seenHeadline.add(hkey);
    deduped.push(row);
  }

  const themeAgg = new Map<string, Agg>();
  const keywordAgg = new Map<string, Agg>();
  for (const row of deduped) {
    const weight = clusterWeight(row);
    const heat = HEAT_RANK[row.temperature] ?? 1;
    for (const tag of uniqueNonEmpty(row.tags)) accumulate(themeAgg, tag, row, weight, heat);
    for (const kw of uniqueNonEmpty(row.keywords)) accumulate(keywordAgg, kw, row, weight, heat);
  }

  return {
    cluster_count: deduped.length,
    // Themes always qualify at ≥1 cluster — tags are curated, so even a
    // single hot exclusive scoop is signal worth surfacing.
    themes: finalize(themeAgg, 1, limit),
    keywords: finalize(keywordAgg, minClusters, limit),
  };
}

type TrendingDbRow = {
  cluster_id: string;
  headline: string;
  primary_domain: string;
  domains: string[];
  temperature: string;
  trajectory: string;
  keywords: string[];
  tags: string[];
};

/**
 * Fetch the in-window candidate pool (status='new', not expired) and
 * compute the trending board. Mirrors list_candidates' active-window
 * filter; ordered latest-first so dedup keeps the freshest row.
 */
export async function computeTrending(db: Db, opts: TrendingOpts = {}): Promise<TrendingBoard> {
  const whereParts = [sql`status = 'new'`, sql`expires_at > NOW()`];
  if (opts.domain) whereParts.push(sql`primary_domain = ${opts.domain}`);
  const whereSql = sql.join(whereParts, sql` AND `);
  // No LIMIT — aggregation needs the whole in-window pool. Cost scales
  // with active-pool size; the WHERE hits idx_candidates_status /
  // idx_candidates_primary_domain_status so the scan stays indexed.
  const rows = await db.execute<TrendingDbRow>(sql`
    SELECT cluster_id, headline, primary_domain, domains,
           temperature, trajectory, keywords, tags
    FROM candidates
    WHERE ${whereSql}
    ORDER BY created_at DESC
  `);
  return computeTrendingFromRows(
    rows.map((r) => ({
      clusterId: r.cluster_id,
      headline: r.headline,
      primaryDomain: r.primary_domain,
      domains: r.domains,
      temperature: r.temperature,
      trajectory: r.trajectory,
      keywords: r.keywords,
      tags: r.tags,
    })),
    opts,
  );
}
